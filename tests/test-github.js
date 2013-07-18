var request = require('request')
  , data = require('./github.json')
  , qs = require('querystring')
  , cleanup = require('cleanup')
  , ok = require('okdone')
  , flipover = require('../')
  , childport = require('childport')
  , assert = require('assert')
  , port
  ;

var d = cleanup(function (error) {
  if (error) return process.exit(1)
  ok.done()
  flip.close()
})

function run (deploy, cb) {
  function finish (e) {
    if (e) throw e
    ok('deploy')
    cb(e, p)
  }
  var p = childport.cp(deploy.port, finish).spawn('node', [__dirname+'/httpserver.js'])
  deploy.outputProcess(p)
}

function test (deploy, cb) {
  if (port) assert.notEqual(port, deploy.port)

  var r = request('http://localhost:'+deploy.port+'/test', function (e, resp, body) {
    if (e) return cb(e)
    if (resp.statusCode !== 200) return cb(new Error('statusCode is not 200', resp.statusCode))
    if (body !== 'ok') return cb(new Error('wrong body, got:'+body))
    cb(null)
    ok(deploy.port)
    if (!port) {
      // first test
      port = deploy.port
      request.post('http://localhost:7171/github', {body:qs.stringify({payload:JSON.stringify(data)})}, function (e, resp, body) {
        if (e) throw e
        assert.equal(resp.statusCode, 200)
        ok('github post')
      })
    } else {
      // second test
      assert.equal(flip.active.port, deploy.port)
      d.cleanup()
    }
  })
}

var flip = flipover(run, test)
flip.listen(8080, 7171)

flip.on('github', function (info) {
  assert.ok(info)
  flip.redeploy()
})

// flip.output()