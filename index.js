const fs = require('fs-extra')
const path = require('path')
const moment = require('moment')
const lowDb = require('lowdb')
const lowDbStorage = require('lowdb/adapters/FileSync')
const sleep = require('sleep-time')
const Slack = require('slack-node')
const rss = require('rss-parser')
const fetch = require('node-fetch')
const crypto = require('crypto')
const urlParser = require('url-parse')
const uniqueBy = require('unique-by');


const slackWebHook = process.env.LABS_SLACK_WEBHOOK_URL_DEVPARANA_BOT_LONDRINA || ''
const dbFile = path.join(__dirname, 'data/db.json')
const file4Tests = path.join(__dirname, 'jobs.rss')
const sandBox = false

if (!fs.existsSync(path.dirname(dbFile)) && !fs.mkdirsSync(path.dirname(dbFile))) {
  throw new Error('Error creating data dir.')
} else if (!slackWebHook) {
  throw new Error('Slack Webhook not found in enviroment variables. Aborting...')
}

const db = lowDb(new lowDbStorage(dbFile))

db.defaults({ jobs: [], settings: {} }).write()

const slack = new Slack()
const rssParser = new rss()
const feedUrls = [
  'http://www.indeed.com.br/rss?q=title%3Adesenvolvedor&l=Londrina%2C+PR&radius=0&sort=date',
  'http://www.indeed.com.br/rss?q=title%3Aprogramador&l=Londrina%2C+PR&radius=0',
  'http://www.indeed.com.br/rss?q=title%3Afront-end&l=Londrina%2C+PR&radius=0',
  'http://www.indeed.com.br/rss?q=title%3Afrontend&l=Londrina%2C+PR&radius=0',
  'http://www.indeed.com.br/rss?q=title%3Ajava&l=Londrina%2C+PR&radius=0',
  'http://www.indeed.com.br/rss?q=title%3Aphp&l=Londrina%2C+PR&radius=0',
]

const feedRSSOptions = {}

slack.setWebhook(slackWebHook)

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
      const title = item.title.replace(new RegExp('- Londrina, PR', 'g'), '')
      const url = item.link
      const description = item.contentSnippet
      const date = moment(item.pubDate).unix().toString()
      const dateProcessed = moment().unix()
      const botProcessed = false
      const botProcessedDate = null
      const company = ''
      const id = urlObj.query && urlObj.query.jk ? urlObj.query.jk : crypto.createHash('sha1').update(title).digest('hex')

      return { id, title, date, company, dateProcessed, description, url, botProcessed, botProcessedDate }
    })

    jobsOffers = uniqueBy(jobsOffers, 'id')

    return new Promise((resolve, reject) => {
      const jobsBaseID = db.get('jobs').value().map(item => item.id)
      jobsOffers.filter(item => jobsBaseID.indexOf(item.id) < 0).forEach(job => db.get('jobs').push(job).write())

      sleep(1000)

      const jobs = Array.from(db.get('jobs').filter({ botProcessed: false }).sortBy('date').reverse().value())

      resolve(jobs)
    });
  }).then((jobs) => {

    _log(`Found ${jobs.length} job offers.`)

    if (jobs.length) {
      _log('Processing items to send to slack...')
    } else {
      _log('No new jobs to send to slack...')
    }

    _log('-'.repeat(100))

    const mainTitle = (jobs.length > 1 ? 'Vagas de trabalho encontradas' : 'Vaga de trabalho encontrada') + ' em *Londrina*. Confira!'
    const slackQueue = jobs.map((item, index) => {
      return () => new Promise((resolve, reject) => {
        _log('Processing item ' + (index + 1))

        let date = moment.unix(item.date).format('DD/MM/YYYY')

        _log(item.title, date)
        _log('-'.repeat(100))

        let params = {
          text: (index === 0 ? mainTitle + '\n\n\n' : '') +
            `*${item.title}* - ${item.url}`
        }

        slack.webhook(params, (err, response) => {
          if (err) {
            return reject(err)
          }
          if (response.statusCode === 200) {
            _log('Done posting item ' + (index + 1))
            _log('-'.repeat(100))
            db.get('jobs').find({ id: item.id }).assign({ botProcessed: true, botProcessedDate: moment().unix() }).write()

            sleep(1000)
            resolve(index)
          } else {
            reject(new Error('Error processing item ' + (index + 1) + ': ' + response.statusCode + ': ' + response.statusMessage))
          }
        })
      })
    })

    Array.from(Array(slackQueue.length).keys()).reduce((promise, next) => {
      return promise.then(() => slackQueue[next]()).catch(err => { throw err })
    }, Promise.resolve())

  }). catch(err => { throw err })

} catch (err) {
  _log('ERROR: ', err)
  _log('-'.repeat(100))
}

function _log () {
  console.log.apply(console, [].concat([`[${moment().format('DD/MM/YYYY HH:mm:ss')}] =>`], Array.from(arguments) || []))
}
