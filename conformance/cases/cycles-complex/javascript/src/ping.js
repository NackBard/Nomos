const { pong } = require("./pong.js");

function ping() {
  return pong();
}

function tick() {
  return 1;
}

module.exports = { ping, tick };
