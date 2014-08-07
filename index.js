var hostproxy = require('hostproxy')
  , domain = require('domain')
  , util = require('util')
  , events = require('events')
  , http = require('http')
  , net = require('net')
  , async = require('async')
  , getport = require('getport')
  , once = require('once')
  , qs = require('querystring')
  , callbackStream = require('callback-stream')
  , DuplexPassThrough = require('duplex-passthrough')
  , noop = function () {}
  ;

function Deployment (flip, test) {
  events.EventEmitter.call(this)
  var self = this
  this.flip = flip
  this.test = test
  this.deployed = false
  this.logs = []
  this.on('log', this.logs.push.bind(this.logs))
  // this.on('log', console.log.bind(console))
  this.on('done', function () {
    self.deployed = true
  })
  this.on('error', function (e) {
    if (e.stack) e = e.stack
    self.emit('log', 'deploy:error::'+e)
  })
}
util.inherits(Deployment, events.EventEmitter)
Deployment.prototype.connect = function () {
  return net.connect(this.port)
}
Deployment.prototype.testInterval = function (ms) {
  var self = this
  setInterval(function () {
    if (self.test) self.test(self, function (e) {
      if (e) self.emit('error', e)
    })
  }, ms)
}
Deployment.prototype.attach = function () {
  var self = this
  self.onActive = function (e) {
    var msg = e ? e.stack || e : 'no error message'
    self.log('activeFail', msg)
    self.flip.emit('activeFail')
  }
  self.on('error', self.onActive)
  self.process.on('exit', self.onActive)
}
Deployment.prototype.detach = function () {
  var self = this
  if (self.onActive) {
    self.removeListener('error', self.onActive)
    self.process.removeListener('exit', self.onActive)
  }
}
Deployment.prototype.close = function (cb) {
  this.detach()
  if (!cb) cb = noop
  cb = once(cb)
  var self = this
  if (self.process) {
    self.process.on('exit', function (code) {
      cb(null, code)
    })
    try { self.process.kill()}
    catch(e) {
      cb(null)
    }
  } else {
    this.on('process', function () {
      self.close(cb)
    })
  }
}
Deployment.prototype.outputProcess = function () {
  // process.stdout.on('data', function (chunk) {self.emit('log', 'child_process:stdout::', chunk.toString())})
  // process.stderr.on('data', function (chunk) {self.emit('log', 'child_process:stderr::', chunk.toString())})
}
Deployment.prototype.log = function () {
  var msg
  if (arguments.length > 1) msg = Array.prototype.join.call(arguments, ', ')
  else msg = arguments[0]
  this.emit('log', msg)
}
Deployment.prototype.abort = function () {
  this.detach()
  this.close()
}

function FlipOver (deploy, test) {
  events.EventEmitter.call(this)
  var self = this
  this.deploy = deploy
  this.test = test
  this.connections = {}
  this.pending = []
  this.active = null
  this.inflight = null
  this.startPort = 3000
  this.mainServer = hostproxy(this.onHost.bind(this))
  this.mainServer.on('domain', this.emit.bind(this, 'domain'))
  // attach this after the fact so that 3rd party listeners can get the active deploy
  setImmediate(function () {
    self.on('activeFail', function () {
      self.emit('log', 'activeFail detected. redeploying.')
      // self.active.close()
      // self.active = false // don't know what is better here, should we *try* to send or just buffer?
      self.start('activeFail')
    })
  })
  this.adminServer = http.createServer(this.adminListener.bind(this))
  this.start('init')
  process.on('exit', function () {
    self.close()
  })
}
util.inherits(FlipOver, events.EventEmitter)
FlipOver.prototype.start = function (trigger) {
  var self = this
    , d = new Deployment(this, this.test)
    ;
  this.emit('newDeploy', d)
  this.emit('log', 'starting new deploy, trigger:'+trigger)
  if (this.inflight) this.inflight.abort()
  this.inflight = d
  d.on('error', self.emit.bind(self, 'deployFail', d))
  setImmediate(function () {
    d.emit('log', 'Looking for free port.')

    getport(self.startPort, function (e, port) {
      if (e) return e.emit('error', e)

      d.emit('log', 'Found free port, ', port)
      d.emit('port', port)
      self.startPort = port + 1

      d.emit('log', 'Starting deploy function')
      d.port = port
      self.deploy(d, function (e, process) {
        if (e) return d.emit('error', e)

        d.emit('log', 'Got process.')
        d.process = process
        d.emit('process', process)
        if (d.test) {
          d.emit('log', 'Running test function.')
          d.test(d, function (e) {
            if (e) return d.emit('error', e)
            d.emit('log', 'test successful')
            self.goodDeploy(d)
          })
        } else {
          d.emit('log', 'No test function.')
          self.goodDeploy(d)
        }
      })
    })
  })
  d.on('done', self.report.bind(self, d))
  d.on('error', self.report.bind(self, d))
  return d
}
FlipOver.prototype.goodDeploy = function (d) {
  if (this.active) {
    this.active.close()
  }
  d.attach()
  this.active = d
  this.inflight = null
  this.pending.forEach(function (s) {
    var dom = domain.create()
      , c = d.connect()

    dom.on('error', function (e) {
      console.error(e)
    })

    dom.add(c)
    s.wrapStream(c)
  })
  this.pending = []
  d.emit('active')
}
FlipOver.prototype.report = function () {}
FlipOver.prototype.onHost = function (host, addHeader, address) {
  addHeader('x-forwarded-for', address.address)
  var ret
  if (!this.active) {
    // buffer
    ret = new DuplexPassThrough()
    this.pending.push(ret)
  } else {
    ret = this.active.connect()
  }
  return ret
}
FlipOver.prototype.adminListener = function (req, resp) {
  var self = this
  // TODO admin interface.
  if (req.url === '/github') {
    var cbstream = callbackStream(function (e, data) {
      var info
        , str = Buffer.concat(data).toString()
        ;
      try {
        info = JSON.parse(qs.parse(str).payload)
      } catch(e) {
        resp.statusCode = 500
        resp.end(e.stack)
      }
      if (info) self.emit('github', info)
      resp.statusCode = 200
      resp.end('ok')
    })
    req.pipe(cbstream)
  } else {
    resp.statusCode = 404
    resp.end()
  }
}
FlipOver.prototype.redeploy = function () {
  this.start('redeploy')
}

FlipOver.prototype.listen = function (mainPort, adminPort, cb) {
  var self = this
    , dom = domain.create()

  dom.on('error', function (e) {
    console.error(e)
  })

  var parallel =
    [ function (cb) {
        self.mainServer.on('connection', function (socket) {
          dom.add(socket)
        })
        self.mainServer.listen(mainPort, cb)
      }
    , function (cb) {
        self.adminServer.on('connection', function (socket) {
          dom.add(socket)
        })
        self.adminServer.listen(adminPort, cb)
      }
    ]
  async.parallel(parallel, cb)
}
FlipOver.prototype.close = function (cb) {
  var parallel = []
    , self = this
    ;
  if (this.active) parallel.push(function (cb) {self.active.close(cb)})
  parallel.push(function (cb) {self.mainServer.close(cb)})
  parallel.push(function (cb) {self.adminServer.close(cb)})
  async.parallel(parallel, cb)
  //TODO: handle inflights
}
FlipOver.prototype.output = function () {
  this.on('log', console.log.bind(console))
  this.on('newDeploy', function (d) {
    d.on('log', console.log.bind(console  ))
  })
}

module.exports = function (deploy, test) {
  return new FlipOver(deploy, test)
}
