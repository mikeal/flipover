### flipover

TCP server and deployment system that flips from one deployment to another.

```javascript
// server.js
var flipover = require('../')
  , childport = require('childport')
  ;

function run (deploy, cb) {
  function finish (e) {
    cb(e, p)
  }
  var p = childport.cp(deploy.port, finish).spawn('node', [__dirname+'/child.js'])
  deploy.outputProcess(p)
}

function test (deploy, cb) {
  request('http://localhost:'+deploy.port+'/test', function (e, resp, body) {
    if (e) return cb(e)
    if (resp.statusCode !== 200) return cb(new Error('statusCode is not 200', resp.statusCode))
  })
}

flipover(run, test).listen(8080, 7171)
```
```javascript
var http = require('http')
  , childport = require('childport')
  ;

childport.listen(http.createServer(function (req, resp) {
  resp.statusCode = 200
  resp.end('ok')
}))
```

#### deploy.port

Port to listen on. Callbacks for new deployments must not be resolved until the server is listening on this port.

#### `flipover(function (deploy, cb) {}, [function test (deploy, cb) {}])`

Returns a flipover server.

Requires a function for you to write your deployment code. This function takes two arguments: a `Deploy` instance and a callback which takes two arguments: `error` and an instance of `child_process.ChildProcess` which will be monitored and killed if need be.

Optionally you can also pass a test function which is used to validate the server is working and test it periodically.

#### `FlipOver.listen(serverPort, adminPort, cb)`

Listen.