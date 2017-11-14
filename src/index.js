/**
 * @copyright 2017-present, Charlike Mike Reagent <olsten.larck@gmail.com>
 * @license Apache-2.0
 */

const path = require('path')
const delay = require('delay')
const semver = require('semver')
const handlebars = require('handlebars')
const detectNext = require('detect-next-version')
const getConfig = require('./lib/config.js')
const utils = require('./lib/utils.js')

/* eslint-disable no-param-reassign */

/**
 *
 * @param {*} robot
 */
module.exports = (robot) => {
  let releasePublished = false

  // robot.on('issues.opened', async (context) => {
  //   const tags = await context.github.repos.getTags({
  //     owner: 'singapore',
  //     repo: 'renovate',
  //   })
  //   console.log(tags.data.length, tags.data[0])
  // })

  robot.on('push', async (context) => {
    if (releasePublished === true) return
    if (context.payload.ref !== 'refs/heads/master') return

    const config = await getConfig(context)
    const commit = detectChange(context, config)
    // Check if commit needs GitHub Release,
    // otherwise the bot should not do anything
    if (commit.increment) {
      const passed = []
      const pending = []
      releasePublished = await release(context, config, { passed, pending })
    }
  })
}

/**
 *
 * @param {*} context
 * @param {*} config
 */
function detectChange (context, config) {
  const head = context.payload.head_commit
  const rawCommit = detectNext(head.message, true)

  const repository = context.payload.repository.full_name
  const link = `https://github.com/${repository}/commit/${head.id}`
  const commit = Object.assign(rawCommit, {
    anchor: `[${head.id.slice(0, 7)}](${link})`,
    message: head.message,
    head,
    link,
  })

  if (commit.increment === 'major' && commit.isBreaking) {
    return Object.assign(commit, { heading: config.majorHeading })
  }
  if (commit.increment === 'patch') {
    return Object.assign(commit, { heading: config.patchHeading })
  }
  if (commit.increment === 'minor') {
    return Object.assign(commit, { heading: config.minorHeading })
  }

  return commit
}

/**
 *
 * @param {*} context
 * @param {*} config
 * @param {*} cache
 */
async function release (context, config, cache) {
  if (cache.passed.length && cache.passed.length === cache.pending.length) {
    return shouldRelease(context, config)
  }

  // Especially in CircleCI builds are pretty fast
  // even with tons of deps.. but make sure your cache
  // is enabled (or correctly configured).
  // Example: if you all checks ends in 1min,
  // only 6 requests are made, so don't worry.
  // The 6req/min is pretty pretty low amount when you have 5000req/hour.
  await delay(5000) // todo

  const statuses = await context.github.repos.getStatuses(utils.getRepo(context))

  statuses.data.forEach((x) => {
    if (x.state === 'pending' && !cache.pending.includes(x.context)) {
      cache.pending.push(x.context)
    }
    if (x.state === 'success' && !cache.passed.includes(x.context)) {
      cache.passed.push(x.context)
    }
  })

  return release(context, config, cache)
}

/**
 *
 * @param {*} context
 * @param {*} config
 */
function shouldRelease (context, config) {
  const commit = detectChange(context, config)

  if (!commit.increment) {
    return false
  }

  return createRelease(context, config, commit)
}

/**
 *
 * @param {*} context
 * @param {*} config
 * @param {*} commit
 */
async function createRelease (context, config, commit) {
  const { currentVersion, nextVersion } = await getVersions(context, config, commit)
  const { owner, repo } = utils.getRepo(context)

  const options = {
    currentVersion,
    nextVersion,
    commit,
    owner,
    repo,
  }
  const body = await renderTemplate(context, config, options)

  const tagName = `v${nextVersion}`

  await context.github.repos.createRelease({
    owner,
    repo,
    body: body.trim(),
    tag_name: tagName,
    name: tagName,
    draft: false,
    prerelease: false,
  })

  console.log('done')

  return true
}

/**
 *
 * @param {*} context
 * @param {*} config
 * @param {*} commit
 */
async function getVersions (context, config, commit) {
  const lastTag = (await context.github.repos.getTags(utils.getRepo(context))).data[0]

  // TODO: Consider what to do when there are no tags. Fallback to npm?
  const currentVersion = lastTag.name.slice(1)

  console.log('tag commit', lastTag.commit.url)

  const nextVersion = semver.inc(currentVersion, commit.increment)
  return { currentVersion, nextVersion }
}

/**
 *
 * @param {*} context
 * @param {*} config
 * @param {*} opts
 */
async function renderTemplate (context, config, opts) {
  let template = config.releaseTemplate

  if (typeof config.templatePath === 'string') {
    const fp = path.resolve(config.templatePath)
    template = await utils.readFile(fp)
  }

  const repository = context.payload.repository.full_name
  const [date] = context.payload.head_commit.timestamp.split('T')
  const { currentVersion: prev, nextVersion: next } = opts
  const compareLink = `https://github.com/${repository}/compare/v${prev}...v${next}`

  const locals = Object.assign({}, config.locals, opts, {
    date,
    repository,
    compareLink,
  })

  return handlebars.compile(template)(locals)
}
