const debug = require('debug')
const fetch = require('node-fetch')
const log = debug('app:provider:youtube')
const Scanner = require('../Scanner')
const Media = require('../../Media')
const parseMeta = require('../../lib/parseMeta')
const parseMetaCfg = require('./lib/parseMetaCfg') // look for .js, .json
const { parse, toSeconds } = require('iso8601-duration')

class YouTubeScanner extends Scanner {
  constructor (prefs) {
    super()
    this.prefs = prefs

    if (!prefs.apiKey) {
      throw new Error('Please set your YouTube API key')
    }
  }

  async scan () {
    const offlineChannels = []
    let items = []
    let validIds = [] // mediaIds for cleanup

    // list all videos from all channels
    for (const channel of this.prefs.channels) {
      if (this.isCanceling) {
        break
      }

      this.emitStatus(`Listing "${channel}"`, 0)

      try {
        const res = await this.getPlaylistItems(channel)
        items = items.concat(res)
      } catch (err) {
        log(`  => ${err.message} (channel offline)`)
        offlineChannels.push(channel)
      }
    } // end for

    if (this.isCanceling) {
      return
    }

    for (let i = 0; i < items.length; i++) {
      if (this.isCanceling) {
        break
      }

      this.emitStatus(`Processing videos (${i} of ${items.length})`, (i / items.length) * 100)

      try {
        const mediaId = await this.process(items[i])
        validIds.push(mediaId)
      } catch (err) {
        log(err)
      }
    } // end for

    if (this.isCanceling) {
      return
    }

    // cleanup
    log('Cleanup: getting orphaned songs')

    try {
      // get all media from valid/online channels
      const res = await Media.getMedia({
        provider: 'youtube',
        providerData: {
          channel: this.prefs.channels.filter(c => !offlineChannels.includes(c)),
        }
      })

      // media we didn't encounter during the scan are invalid
      const invalidIds = res.result.filter(id => !validIds.includes(id))

      log('  => removing %s songs', invalidIds.length)
      await Media.remove(invalidIds)
    } catch (err) {
      log(err)
    }

    // done
  }

  /**
   * List all videos in a channel (using its "uploads" playlist)
   *
   * @param  {string}  channel YT channel or username
   * @return {Promise} array of video items
   */
  async getPlaylistItems (channel) {
    let playlistId, playlist
    let items = []

    // get channel/playlist info for youtube user
    try {
      let res = await this.callApi(`channels?forUsername=${channel}&part=contentDetails`)
      playlistId = res.items[0].contentDetails.relatedPlaylists.uploads

      if (typeof playlistId !== 'string') {
        throw new Error('invalid playlist id')
      }
    } catch (err) {
      return Promise.reject(err)
    }

    if (this.isCanceling) {
      return
    }

    // get playlist page by page
    do {
      let url = `playlistItems?playlistId=${playlistId}&maxResults=50&part=snippet`

      if (playlist && playlist.nextPageToken) {
        url += '&pageToken=' + playlist.nextPageToken
      }

      try {
        playlist = await this.callApi(url)
      } catch (err) {
        return Promise.reject(err)
      }

      if (this.isCanceling) {
        break
      }

      // get durations for playlist items
      let videoIds = playlist.items.map(item => item.snippet.resourceId.videoId)
      let details

      try {
        details = await this.callApi(`videos?part=contentDetails&id=` + videoIds.join(','))
      } catch (err) {
        return Promise.reject(err)
      }

      // merge snippet and contentDetails data into one
      // object and add it to our final array of items
      playlist.items.forEach((item, i) => {
        items.push(Object.assign({
          channel,
        }, playlist.items[i], details.items[i]))
      })

      this.emitStatus(`Listing "${channel}" (${items.length} of ${playlist.pageInfo.totalResults})`,
        (items.length / playlist.pageInfo.totalResults) * 100)

      log('got %s of %s items', items.length, playlist.pageInfo.totalResults)
    } while (playlist.nextPageToken && !this.isCanceling)

    return items
  }

  /**
   * Process a video item
   *
   * @param  {object} item YT composite (snippet + details) video item
   * @return {number} mediaId
   */
  async process (item) {
    log('processing: %s', JSON.stringify({
      title: item.snippet.title,
      videoId: item.id,
      duration: item.contentDetails.duration,
    }))

    // is video already in the db?
    try {
      const res = await Media.getMedia({
        provider: 'youtube',
        providerData: { videoId: item.id },
      })

      log('  => %s result(s) for existing media', res.result.length)

      // @todo: check mtime and title for updates

      if (res.result.length) {
        log('  => found media in library (same videoId)')
        return Promise.resolve(res.result[0])
      }
    } catch (err) {
      return Promise.reject(err)
    }

    // new song
    const { artist, title } = parseMeta(item.snippet.title, parseMetaCfg)

    if (!artist || !title) {
      log(' => skipping: couldn\'t parse artist/title from video title')
      return Promise.reject(new Error('couldn\'t parse artist/title'))
    }

    const song = {
      artist,
      title,
      provider: 'youtube',
      duration: toSeconds(parse(item.contentDetails.duration)),
      providerData: {
        videoId: item.id,
        channel: item.channel,
        publishedAt: item.snippet.publishedAt,
      }
    }

    try {
      const mediaId = await Media.add(song)
      return Promise.resolve(mediaId)
    } catch (err) {
      return Promise.reject(err)
    }
  }

  /**
  * Make an API call
  *
  * @param  {string}  params Appended to the base URL
  * @return {Promise}        Decoded JSON response
  */
  async callApi (params) {
    const API = 'https://www.googleapis.com/youtube/v3/'
    const url = API + params + `&key=${this.prefs.apiKey}`
    log('request: %s', API + params.substr(0, params.indexOf('?')))

    try {
      let res = await fetch(url)
      let decoded = await res.json()
      return Promise.resolve(decoded)
    } catch (err) {
      return Promise.reject(err)
    }
  }
}

module.exports = YouTubeScanner
