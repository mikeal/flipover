var flipover = require('../')
  , http = require('http')
  , childport = require('childport')
  , assert = require('assert')
  , request = require('request')
  , child_process = require('child_process')
  , ok = require('okdone')
  ;

flipover(function (deploy, cb) {
  function finish (e) {
    if (e) throw e
    ok('deploy')
    cb(e, p)
  }
  var p = childport.cp(deploy.port, finish).spawn('node', [__dirname+'/httpserver.js'])
  deploy.outputProcess(p)
}).listen(8080, 7171)

var r = request('http://localhost:8080/test', function (e, resp, body) {
  if (e) throw e
  if (resp.statusCode !== 200) throw new Error('statusCode is not 200', resp.statusCode)
  assert.equal(body, 'ok')
  ok('response')
  ok.done()
  process.exit()
})

// var child_process = require('child_process')
// var c = child_process.spawn('node', [__dirname+'/httpserver.js'])
// c.stdout.pipe(process.stdout)
// c.stderr.pipe(process.stderr)