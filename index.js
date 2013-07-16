var hostproxy = require('hostproxy')
  , uuid = require('node-uuid')
  , stream = require('stream')
  , util = require('util')
  , events = require('events')
  , http = require('http')
  , net = require('net')
  , async = require('async')
  , getport = require('getport')
  , once = require('once')
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
  this.on('error', console.error.bind(console, 'deploy error:'))
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
  })
}
Deployment.prototype.attach = function () {
  var self = this
  self.onActive = function () {
    self.flip.emit('activeFail')
  }
  self.on('error', self.onActive)
}
Deployment.prototype.detach = function () {
  self.removeListener('error', self.onActive)
}
Deployment.prototype.close = function (cb) {
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
Deployment.prototype.outputProcess = function (process) {
  var self = this
  process.stdout.on('data', function (chunk) {self.emit('log', 'child_process:stdout::', chunk.toString())})
  process.stderr.on('data', function (chunk) {self.emit('log', 'child_process:stderr::', chunk.toString())})
}

function FlipOver (deploy, test) {
  events.EventEmitter.call(this)
  var self = this
  this.deploy = deploy
  this.test = test
  this.connections = {}
  this.pending = []
  this.active = null
  this.startPort = 3000
  this.mainServer = hostproxy(this.onHost.bind(this))
  this.mainServer.on('domain', this.emit.bind(this, 'domain'))
  // attach this after the fact so that 3rd party listeners can get the active deploy
  setImmediate(function () {
    self.on('activeFail', function () {
      self.active = false // don't know what is better here, should we *try* to send or just buffer?
      self.start()
    })
  })
  this.adminServer = http.createServer(this.adminListener)
  this.start()
  process.on('exit', function () {
    self.close()
  })
}
util.inherits(FlipOver, events.EventEmitter)
FlipOver.prototype.start = function () {
  var self = this
    , d = new Deployment(this, this.test)
    ;
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
  var self = this
  if (this.active) {
    this.active.detach()
    this.active.close()
  }
  d.attach()
  this.active = d
  this.pending.forEach(function (s) {
    var c = d.connect()
    if (s.domain) s.domain.bind(c)
    s.wrapStream(c)
  })
  this.pending = []
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
    callbackStream(req, function (e, data) {
      var info
        , str = Buffer.concat(data).toString()
        ;
      try {info = JSON.parse(str)}
      catch(e) {
        resp.statusCode = 500
        resp.end(e.stack)
      }
      if (info) self.emit('github', info)
    })
  } else {
    resp.statusCode = 404
    resp.end()
  }
}
FlipOver.prototype.redeploy = function () {
  this.start()
}

FlipOver.prototype.listen = function (mainPort, adminPort, cb) {
  var self = this
  var parallel =
    [ function (cb) { self.mainServer.listen(mainPort, cb) }
    , function (cb) { self.adminServer.listen(adminPort, cb) }
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

module.exports = function (deploy, test) {
  return new FlipOver(deploy, test)
}