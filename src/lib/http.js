/*****
 License
 --------------
 Copyright © 2020-2025 Mojaloop Foundation
 The Mojaloop files are made available by the Mojaloop Foundation under the Apache License, Version 2.0 (the "License") and you may not use these files except in compliance with the License. You may obtain a copy of the License at

 http://www.apache.org/licenses/LICENSE-2.0

 Unless required by applicable law or agreed to in writing, the Mojaloop files are distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.

 Contributors
 --------------
 This is the official list of the Mojaloop project contributors for this file.
 Names of the original copyright holders (individuals or organizations)
 should be listed with a '*' in the first column. People who have
 contributed from an organization can be listed under the organization
 that actually holds the copyright for their contributions (see the
 Mojaloop Foundation for an example). Those individuals should have
 their names indented and be marked with a '-'. Email address can be added
 optionally within square brackets <email>.

 * Mojaloop Foundation
 - Name Surname <name.surname@mojaloop.io>

 Initial contribution
 --------------------
 The initial functionality and code base was donated by the Mowali project working in conjunction with MTN and Orange as service provides.
 * Project: Mowali

 * ModusBox
 - Georgi Georgiev <georgi.georgiev@modusbox.com>
 - Henk Kodde <henk.kodde@modusbox.com>
 - Matt Kingston <matt.kingston@modusbox.com>
 - Vassilis Barzokas <vassilis.barzokas@modusbox.com>
 --------------
 ******/
const http = require('node:http')
const https = require('node:https')
const util = require('node:util')
const axios = require('axios')
const ErrorHandler = require('@mojaloop/central-services-error-handling')
const CacheableLookup = require('cacheable-lookup').default

const { logger } = require('../lib')
const Config = require('./config')

const config = new Config()
// Create DNS cache with aggressive caching for performance
const dnsCache = new CacheableLookup({
  maxTtl: 3600, // Cache for 5 minutes
  errorTtl: 5, // Cache errors briefly
  cache: new Map()
})

// Optimized HTTP Agent
const httpAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 50, // Reduce if not needed
  maxFreeSockets: 10,
  timeout: 0,
  freeSocketTimeout: 30000, // Reduce free socket timeout
  keepAliveMsecs: 1000
})

// Optimized HTTPS Agent
const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 50,
  maxFreeSockets: 10,
  timeout: 0,
  freeSocketTimeout: 30000,
  keepAliveMsecs: 1000
})

// Install DNS cache on both agents
dnsCache.install(httpAgent)
dnsCache.install(httpsAgent)

// Set as defaults
axios.defaults.httpAgent = httpAgent
axios.defaults.httpsAgent = httpsAgent
axios.defaults.httpAgent.toJSON = () => ({})
axios.defaults.httpsAgent.toJSON = () => ({})

axios.defaults.proxy = false
axios.defaults.timeout = 10000 // Increase timeout slightly
axios.defaults.maxBodyLength = 50 * 1024 * 1024
axios.defaults.maxContentLength = 50 * 1024 * 1024
axios.defaults.headers.common = {}

const axiosInstance = axios.create({
  httpAgent: httpAgent,
  httpsAgent: httpsAgent,
  // Add these for better performance
  validateStatus: (status) => status < 500 // Don't retry on 4xx errors
})

axiosInstance.interceptors.request.use(cfg => {
  cfg.metadata = { start: process.hrtime.bigint() }
  return cfg
})

axiosInstance.interceptors.response.use(res => {
  const end = process.hrtime.bigint()
  const ms = Number(end - res.config.metadata.start) / 1e6
  const sock = res.request?.socket
  const reused = res.request?.reusedSocket

  // Log performance metrics with more detail
  logger.info(`perf axios ${ms.toFixed(1)}ms reused=${reused} remote=${sock?.remoteAddress}:${sock?.remotePort} url=${res.config.url}`)

  // Warn if request is slow despite connection reuse
  if (ms > 1000 && reused) {
    logger.warn(`Slow request despite connection reuse: ${ms.toFixed(1)}ms for ${res.config.url}`)
  }

  return res
}, err => {
  if (err.request) {
    const reused = err.request.reusedSocket
    logger.warn(`axios error reused=${reused} code=${err.code} url=${err.config?.url}`)
  }
  throw err
})

/**
 * Encapsulates making an HTTP request and translating any error response into a domain-specific
 * error type.
 *
 * @param {Object} opts
 * @param {String} fspiopSource
 * @returns {Promise<void>}
 */
async function httpRequest (opts, fspiopSource) {
  const log = logger.child({ component: 'httpRequest', fspiopSource })
  log.debug('httpRequest is started...')
  let res
  let body
  try {
    res = await httpRequestBase(opts, axiosInstance)
    body = await res.data
    log.verbose('httpRequest is finished', { body, opts })
  } catch (e) {
    log.error('httpRequest failed due to an error:', e)
    const [fspiopErrorType, fspiopErrorDescr] = e.response && e.response.status === 404
      ? [ErrorHandler.Enums.FSPIOPErrorCodes.CLIENT_ERROR, 'Not found']
      : [ErrorHandler.Enums.FSPIOPErrorCodes.DESTINATION_COMMUNICATION_ERROR, 'Network error']
    throw ErrorHandler.CreateFSPIOPError(fspiopErrorType, fspiopErrorDescr,
      `${e.stack || util.inspect(e)}. Opts: ${util.inspect(opts)}`,
      fspiopSource)
  }

  if (res.status < 200 || res.status >= 300) {
    const errObj = {
      opts,
      status: res.status,
      statusText: res.statusText,
      body
    }
    log.warn('httpRequest returned non-success status code', errObj)

    throw ErrorHandler.CreateFSPIOPError(ErrorHandler.Enums.FSPIOPErrorCodes.DESTINATION_COMMUNICATION_ERROR,
      'Non-success response in HTTP request',
      `${errObj}`,
      fspiopSource)
  }

  return body
}

async function httpRequestBase (opts, axiosInst = axiosInstance) {
  return axiosInst.request({
    timeout: config.httpRequestTimeoutMs,
    ...opts
  })
}

module.exports = {
  httpRequest,
  httpRequestBase
}
