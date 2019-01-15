const fs = require('fs-extra')
const path = require('path')
const moment = require('moment')
const lowDb = require('lowdb')
const LowDbStorage = require('lowdb/adapters/FileSync')
const sleep = require('sleep-time')
const Rss = require('rss-parser')
const fetch = require('node-fetch')
const crypto = require('crypto')
const urlParser = require('url-parse')
const uniqueBy = require('unique-by')
const { IncomingWebhook: SlackIncomingWebhook, WebClient: SlackWebClient } = require('@slack/client')
const Regex = require('xregexp')

const SLACK_WEBHOOK = process.env.LABS_SLACK_WEBHOOK_URL_DEVPARANA_BOT_LONDRINA || ''
const SLACK_BOT_TOKEN = process.env.LABS_SLACK_BOT_VAGAS_TOKEN_DEVPARANA || ''

const dbFile = path.join(__dirname, 'data/db.json')
const file4Tests = path.join(__dirname, 'jobs.rss')
const sandBox = false

if (!fs.existsSync(path.dirname(dbFile)) && !fs.mkdirsSync(path.dirname(dbFile))) {
  throw new Error('Error creating data dir.')
} else if (!SLACK_WEBHOOK || !SLACK_BOT_TOKEN) {
  _log('ERROR: SLACK_WEBHOOK or SLACK_BOT_TOKEN are undefined.')
  _log('Aborting...')
  process.exit(1)
}

const db = lowDb(new LowDbStorage(dbFile))

db.defaults({ jobs: [], settings: {} }).write()

const rssParser = new Rss()
const feedUrls = [
  'http://www.indeed.com.br/rss?q=title%3Adesenvolvedor&l=Londrina%2C+PR&radius=0',
  'http://www.indeed.com.br/rss?q=title%3Aprogramador&l=Londrina%2C+PR&radius=0',
  'http://www.indeed.com.br/rss?q=title%3Afront-end&l=Londrina%2C+PR&radius=0',
  'http://www.indeed.com.br/rss?q=title%3Afrontend&l=Londrina%2C+PR&radius=0',
  'http://www.indeed.com.br/rss?q=title%3Ajava&l=Londrina%2C+PR&radius=0',
  'http://www.indeed.com.br/rss?q=title%3Aphp&l=Londrina%2C+PR&radius=0'
]
// blacklist of certain words / expressions in title, to filter found Jobs
const blacklist = [
  'torno',
  'cnc',
  'ppcp',
  'usinagem',
  'bordado',
  /venda?s/ig,
  /vendedor/ig,
  /servi[\xE7\xC7]os?/ig,
  /ve[\xCD\xED]culos?/ig,
  /manuten[\xC7\xE7][\xC3\xE3]o/ig,
  /neg[\xF3\xD3]cios?/ig
  // NOTE: if you decide to use regular expression, don't forget the "ig" flags
]
const cityReplace = [
  '- Londrina, PR',
  '\\(Londrina PR\\)',
  'em Londrina/PR',
  '()'
]


const slackClient = new SlackWebClient(SLACK_BOT_TOKEN)

try {
  (new Promise((resolve, reject) => {
    if (sandBox && fs.existsSync(file4Tests)) {
      rssParser.parseString(fs.readFileSync(file4Tests), (err, result) => {
        if (err) {
          return reject(err)
        } else if (!result.items || !result.items.length) {
          return reject(new Error('No Job entries were found.'))
        }

        resolve(result.items)
      })
    } else {
      if (sandBox) {
        fetch(feedUrls.shift()).then(res => res.text()).then(body => fs.writeFileSync(file4Tests, body, 'utf-8'))
      }

      let resultJobs = []
      const feedQueue = feedUrls.map((feedUrl, index) => {
        return new Promise((resolve, reject) => {
          rssParser.parseURL(feedUrl, (err, result) => {
            if (err) {
              return reject(err)
            }

            resultJobs = resultJobs.concat(result.items || [])
            resolve(index)
          })
        })
      })

      return Promise.all(feedQueue).then(result => {
        resolve(resultJobs)
      })
    }
  })).then(result => {
    let jobsOffers = result.map(item => {
      const urlObj = urlParser(item.link, true)

      // const id = crypto.createHash('sha1').update(item.link).digest('hex')
      // const id = item.guid
      let title = item.title
      cityReplace.forEach(word => {
        title = title.replace(new RegExp(word, 'g'), '')
      })

      const id = urlObj.query && urlObj.query.jk ? urlObj.query.jk : crypto.createHash('sha1').update(title).digest('hex')
      const url = item.link
      const description = item.contentSnippet
      const date = moment(item.pubDate).unix().toString()
      const dateProcessed = moment().unix()
      const botProcessed = false
      const botProcessedDate = null
      const company = ''

      return { id, title, date, company, dateProcessed, description, url, botProcessed, botProcessedDate }
    })

    jobsOffers = uniqueBy(jobsOffers, 'id').filter((job) => {
      const test = blacklist.filter((word) => {
        const regex = word.constructor !== RegExp ? new RegExp(`\\b${word}\\b`, 'igm') : word

        return Regex(regex).test(job.title)
      })

      return test.length === 0
    })

    return new Promise((resolve, reject) => {
      const jobsBaseID = db.get('jobs').value().map(item => item.id)
      jobsOffers.filter(item => jobsBaseID.indexOf(item.id) < 0).forEach(job => db.get('jobs').push(job).write())

      sleep(1000)

      const jobs = Array.from(db.get('jobs').filter({ botProcessed: false }).sortBy('date').reverse().value())

      resolve(jobs)
    })
  }).then((jobs) => {
    _log(`Found ${jobs.length} job offers.`)

    if (jobs.length) {
      _log('Processing items to send to slack...')
    } else {
      _log('No new jobs to send to slack...')
      return false
    }

    _log('-'.repeat(100))

    const slackQueue = jobs.map((item, index) => {
      return (thread) => new Promise((resolve, reject) => {
        _log('Processing item ' + (index + 1))

        const slackWebhook = new SlackIncomingWebhook(SLACK_WEBHOOK)

        let date = moment.unix(item.date).format('DD/MM/YYYY')

        _log(item.title, date)
        _log('-'.repeat(100))

        let params = {
          text: `*${item.title}* - ${item.url}`
        }

        if (thread) {
          params.thread_ts = thread
        }

        slackWebhook.send(params, (err, response) => {
          if (err) {
            return reject(err)
          }
          _log('Done posting item ' + (index + 1))
          _log('-'.repeat(100))

          db.get('jobs').find({ id: item.id }).assign({ botProcessed: true, botProcessedDate: moment().unix() }).write()

          sleep(1000)
          resolve(index)
        })
      })
    })

    slackClient.chat.postMessage({
      text: (jobs.length > 1 ? 'Vagas de trabalho encontradas' : 'Vaga de trabalho encontrada') + ' em *Londrina*. Confira!',
      channel: '#vagas'
    }).then(response => {
      if (!response.ok) {
        throw new Error(response.error)
      }

      const thread = response.ts

      Array.from(Array(slackQueue.length).keys()).reduce((promise, next) => {
        return promise.then(() => slackQueue[next](thread).catch(err => { throw err })).catch(err => { throw err })
      }, Promise.resolve())
    }).catch(err => { throw err })
  }).catch(err => { throw err })
} catch (err) {
  _log('ERROR: ', err)
  _log('-'.repeat(100))
}

function _log () {
  console.log.apply(console, [].concat([`[${moment().format('DD/MM/YYYY HH:mm:ss')}] =>`], Array.from(arguments) || []))
}
