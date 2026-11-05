const { tick } = require("./ping.js");

function pong() {
  return String(tick());
}

module.exports = { pong };
