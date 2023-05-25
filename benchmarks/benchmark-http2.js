'use strict'

const https = require('https')
const os = require('os')
const path = require('path')
const { table } = require('table')
const { Writable } = require('stream')
const { WritableStream } = require('stream/web')
const { isMainThread } = require('worker_threads')

const { Pool, Client, fetch, Agent, setGlobalDispatcher } = require('..')

const iterations = (parseInt(process.env.SAMPLES, 10) || 10) + 1
const errorThreshold = parseInt(process.env.ERROR_TRESHOLD, 10) || 3
const connections = parseInt(process.env.CONNECTIONS, 10) || 50
const pipelining = parseInt(process.env.PIPELINING, 10) || 10
const parallelRequests = parseInt(process.env.PARALLEL, 10) || 100
const headersTimeout = parseInt(process.env.HEADERS_TIMEOUT, 10) || 0
const bodyTimeout = parseInt(process.env.BODY_TIMEOUT, 10) || 0
const dest = {}

if (process.env.PORT) {
  dest.port = process.env.PORT
  dest.url = `https://localhost:${process.env.PORT}`
} else {
  dest.url = 'https://localhost'
  dest.socketPath = path.join(os.tmpdir(), 'undici.sock')
}

const httpBaseOptions = {
  protocol: 'https:',
  hostname: 'localhost',
  method: 'GET',
  path: '/',
  query: {
    frappucino: 'muffin',
    goat: 'scone',
    pond: 'moose',
    foo: ['bar', 'baz', 'bal'],
    bool: true,
    numberKey: 256
  },
  ...dest
}

const httpNoKeepAliveOptions = {
  ...httpBaseOptions,
  agent: new https.Agent({
    keepAlive: false,
    maxSockets: connections,
    rejectUnauthorized: false
  })
}

const httpKeepAliveOptions = {
  ...httpBaseOptions,
  agent: new https.Agent({
    keepAlive: true,
    maxSockets: connections,
    rejectUnauthorized: false
  })
}

const undiciOptions = {
  path: '/',
  method: 'GET',
  headersTimeout,
  bodyTimeout
}

const Class = connections > 1 ? Pool : Client
const dispatcher = new Class(httpBaseOptions.url, {
  pipelining,
  connections,
  connect: {
    rejectUnauthorized: false
  },
  ...dest
})

setGlobalDispatcher(new Agent({
  pipelining,
  connections,
  connect: {
    rejectUnauthorized: false
  }
}))

class SimpleRequest {
  constructor(resolve) {
    this.dst = new Writable({
      write(chunk, encoding, callback) {
        callback()
      }
    }).on('finish', resolve)
  }

  onConnect(abort) { }

  onHeaders(statusCode, headers, resume) {
    this.dst.on('drain', resume)
  }

  onData(chunk) {
    return this.dst.write(chunk)
  }

  onComplete() {
    this.dst.end()
  }

  onError(err) {
    throw err
  }
}

function makeParallelRequests(cb) {
  return Promise.all(Array.from(Array(parallelRequests)).map(() => new Promise(cb)))
}

function printResults(results) {
  // Sort results by least performant first, then compare relative performances and also printing padding
  let last

  const rows = Object.entries(results)
    // If any failed, put on the top of the list, otherwise order by mean, ascending
    .sort((a, b) => (!a[1].success ? -1 : b[1].mean - a[1].mean))
    .map(([name, result]) => {
      if (!result.success) {
        return [name, result.size, 'Errored', 'N/A', 'N/A']
      }

      // Calculate throughput and relative performance
      const { size, mean, standardError } = result
      const relative = last !== 0 ? (last / mean - 1) * 100 : 0

      // Save the slowest for relative comparison
      if (typeof last === 'undefined') {
        last = mean
      }

      return [
        name,
        size,
        `${((connections * 1e9) / mean).toFixed(2)} req/sec`,
        `± ${((standardError / mean) * 100).toFixed(2)} %`,
        relative > 0 ? `+ ${relative.toFixed(2)} %` : '-'
      ]
    })

  console.log(results)

  // Add the header row
  rows.unshift(['Tests', 'Samples', 'Result', 'Tolerance', 'Difference with slowest'])

  return table(rows, {
    columns: {
      0: {
        alignment: 'left'
      },
      1: {
        alignment: 'right'
      },
      2: {
        alignment: 'right'
      },
      3: {
        alignment: 'right'
      },
      4: {
        alignment: 'right'
      }
    },
    drawHorizontalLine: (index, size) => index > 0 && index < size,
    border: {
      bodyLeft: '│',
      bodyRight: '│',
      bodyJoin: '│',
      joinLeft: '|',
      joinRight: '|',
      joinJoin: '|'
    }
  })
}

const experiments = {
  // 'https - no keepalive'() {
  //   return makeParallelRequests(resolve => {
  //     https.get(httpNoKeepAliveOptions, res => {
  //       res
  //         .pipe(
  //           new Writable({
  //             write(chunk, encoding, callback) {
  //               callback()
  //             }
  //           })
  //         )
  //         .on('finish', resolve)
  //     })
  //   })
  // },
  // 'https - keepalive'() {
  //   return makeParallelRequests(resolve => {
  //     https.get(httpKeepAliveOptions, res => {
  //       res
  //         .pipe(
  //           new Writable({
  //             write(chunk, encoding, callback) {
  //               callback()
  //             }
  //           })
  //         )
  //         .on('finish', resolve)
  //     })
  //   })
  // },
  'undici - pipeline'() {
    return makeParallelRequests(resolve => {
      dispatcher
        .pipeline(undiciOptions, data => {
          return data.body
        })
        .end()
        .pipe(
          new Writable({
            write(chunk, encoding, callback) {
              callback()
            }
          })
        )
        .on('finish', resolve)
    })
  },
  'undici - request'() {
    return makeParallelRequests(resolve => {
      dispatcher.request(undiciOptions).then(({ body }) => {
        body
          .pipe(
            new Writable({
              write(chunk, encoding, callback) {
                callback()
              }
            })
          )
          .on('finish', resolve)
      })
    })
  },
  'undici - stream'() {
    return makeParallelRequests(resolve => {
      return dispatcher
        .stream(undiciOptions, () => {
          return new Writable({
            write(chunk, encoding, callback) {
              callback()
            }
          })
        })
        .then(resolve)
    })
  },
  'undici - dispatch'() {
    return makeParallelRequests(resolve => {
      dispatcher.dispatch(undiciOptions, new SimpleRequest(resolve))
    })
  }
}

if (process.env.PORT) {
  // fetch does not support the socket
  experiments['undici - fetch'] = () => {
    return makeParallelRequests(resolve => {
      fetch(dest.url, {}).then(res => {
        res.body.pipeTo(new WritableStream({ write() { }, close() { resolve() } }))
      }).catch(console.log)
    })
  }
}

async function main() {
  const { cronometro } = await import('cronometro')

  cronometro(
    experiments,
    {
      iterations,
      errorThreshold,
      print: false
    },
    (err, results) => {
      if (err) {
        throw err
      }

      console.log(printResults(results))
      dispatcher.destroy()
    }
  )
}

if (isMainThread) {
  main()
} else {
  module.exports = main
}
