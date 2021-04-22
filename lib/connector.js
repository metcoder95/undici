'use strict'

const net = require('net')
const tls = require('tls')
const assert = require('assert')

class Connector {
  constructor ({ tls, url, socketPath }) {
    this.url = url
    this.tls = tls
    this.socketPath = socketPath
    this.session = tls && tls.session
    this.servername = (
      (tls && tls.servername) ||
      (url && url.host) ||
      null
    )

    this.onSession = (session) => {
      this.session = session
    }
    this.onError = (err) => {
      if (err.code !== 'UND_ERR_INFO') {
        this.session = null
      }
    }
  }

  connect ({ servername }, callback) {
    let { protocol, port, hostname } = this.url

    // Resolve ipv6
    if (hostname.startsWith('[')) {
      const idx = hostname.indexOf(']')

      assert(idx !== -1)
      const ip = hostname.substr(1, idx - 1)

      assert(net.isIP(ip))
      hostname = ip
    }

    let socket
    if (protocol === 'https:') {
      const tlsOpts = servername
        ? { ...this.tls, servername }
        : { ...this.tls, servername: this.servername, session: this.session }

      /* istanbul ignore next: https://github.com/mcollina/undici/issues/267 */
      socket = this.socketPath
        ? tls.connect(this.socketPath, tlsOpts)
        : tls.connect(port || /* istanbul ignore next */ 443, hostname, tlsOpts)

      if (this.tls.reuseSessions !== false && !servername) {
        socket
          .on('session', this.onSession)
          .on('error', this.onError)
      }
    } else {
      socket = this.socketPath
        ? net.connect(this.socketPath)
        : net.connect(port || /* istanbul ignore next */ 80, hostname)
    }

    socket
      .setNoDelay(true)
      .once(protocol === 'https:' ? 'secureConnect' : 'connect', callback)

    return socket
  }

  detach (socket) {
    socket
      .removeListener('session', this.onSession)
      .removeListener('error', this.onError)
  }
}

module.exports = Connector
