var http = require('http')
  , childport = require('childport')
  ;

childport.listen(http.createServer(function (req, resp) {
  resp.statusCode = 200
  resp.end('ok')
})).on('connect', console.log)