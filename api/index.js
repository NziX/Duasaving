module.exports = function(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.statusCode = 200;
  res.end(JSON.stringify({ ok: true, time: new Date().toISOString(), url: req.url }));
};
