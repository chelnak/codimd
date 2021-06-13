// response
// external modules
import * as request from "request";
// core
import config from "./config";
import {logger} from "./logger";
import * as models from "./models";
import {createNoteWithRevision} from "./services/note";
import * as utils from "./utils";
import * as  history from "./history";

export function errorForbidden(req, res) {
  if (req.user) {
    responseError(res, '403', 'Forbidden', 'oh no.')
  } else {
    const nextURL = new URL('', config.serverURL)
    nextURL.search = (new URLSearchParams({next: req.originalUrl})).toString()
    req.flash('error', 'You are not allowed to access this page. Maybe try logging in?')
    res.redirect(nextURL.toString())
  }
}

export function errorNotFound(req, res) {
  responseError(res, '404', 'Not Found', 'oops.')
}

export function errorBadRequest(req, res) {
  responseError(res, '400', 'Bad Request', 'something not right.')
}

export function errorTooLong(req, res) {
  responseError(res, '413', 'Payload Too Large', 'Shorten your note!')
}

export function errorInternalError(req, res) {
  responseError(res, '500', 'Internal Error', 'wtf.')
}

export function errorServiceUnavailable(req, res) {
  res.status(503).send('I\'m busy right now, try again later.')
}

export function responseError(res, code, detail, msg) {
  res.status(code).render('error.ejs', {
    title: code + ' ' + detail + ' ' + msg,
    code: code,
    detail: detail,
    msg: msg
  })
}

export function responseCodiMD(res, note) {
  const body = note.content
  const extracted = models.Note.extractMeta(body)
  const meta = models.Note.parseMeta(extracted.meta)
  let title = models.Note.decodeTitle(note.title)
  title = models.Note.generateWebTitle(meta.title || title)
  res.set({
    'Cache-Control': 'private', // only cache by client
    'X-Robots-Tag': 'noindex, nofollow' // prevent crawling
  })
  res.render('codimd.ejs', {
    title: title
  })
}

function updateHistory(userId, note, document, time?: any) {
  const noteId = note.alias ? note.alias : models.Note.encodeNoteId(note.id)
  history.updateHistory(userId, noteId, document, time)
  logger.info('history updated')
}

export function newNote(req, res, next?: any) {
  let owner = null
  let body = ''
  if (req.body && req.body.length > config.documentMaxLength) {
    return errorTooLong(req, res)
  } else if (req.body) {
    body = req.body
  }
  body = body.replace(/[\r]/g, '')
  if (req.isAuthenticated()) {
    owner = req.user.id
  } else if (!config.allowAnonymous) {
    return errorForbidden(req, res)
  }
  createNoteWithRevision({
    ownerId: owner,
    alias: req.alias ? req.alias : null,
    content: body
  }).then(function (note) {
    if (req.isAuthenticated()) {
      updateHistory(owner, note, body)
    }

    return res.redirect(config.serverURL + '/' + models.Note.encodeNoteId(note.id))
  }).catch(function (err) {
    logger.error(err)
    return errorInternalError(req, res)
  })
}

export function newCheckViewPermission(note, isLogin, userId) {
  if (note.permission === 'private') {
    return note.ownerId === userId
  }
  if (note.permission === 'limited' || note.permission === 'protected') {
    return isLogin
  }
  return true
}

export function checkViewPermission(req, note) {
  if (note.permission === 'private') {
    if (!req.isAuthenticated() || note.ownerId !== req.user.id) {
      return false
    } else {
      return true
    }
  } else if (note.permission === 'limited' || note.permission === 'protected') {
    if (!req.isAuthenticated()) {
      return false
    } else {
      return true
    }
  } else {
    return true
  }
}

function findNote(req, res, callback, include?: any) {
  const noteId = req.params.noteId
  const id = req.params.noteId || req.params.shortid
  models.Note.parseNoteId(id, function (err, _id) {
    if (err) {
      logger.error(err)
      return errorInternalError(req, res)
    }
    models.Note.findOne({
      where: {
        id: _id
      },
      include: include || null
    }).then(function (note) {
      if (!note) {
        if (config.allowFreeURL && noteId && !config.forbiddenNoteIDs.includes(noteId)) {
          req.alias = noteId
          return newNote(req, res)
        } else {
          return errorNotFound(req, res)
        }
      }
      if (!checkViewPermission(req, note)) {
        return errorForbidden(req, res)
      } else {
        return callback(note)
      }
    }).catch(function (err) {
      logger.error(err)
      return errorInternalError(req, res)
    })
  })
}

function actionDownload(req, res, note) {
  const body = note.content
  const title = models.Note.decodeTitle(note.title)
  let filename = title
  filename = encodeURIComponent(filename)
  res.set({
    'Access-Control-Allow-Origin': '*', // allow CORS as API
    'Access-Control-Allow-Headers': 'Range',
    'Access-Control-Expose-Headers': 'Cache-Control, Content-Encoding, Content-Range',
    'Content-Type': 'text/markdown; charset=UTF-8',
    'Cache-Control': 'private',
    'Content-disposition': 'attachment; filename=' + filename + '.md',
    'X-Robots-Tag': 'noindex, nofollow' // prevent crawling
  })
  res.send(body)
}

export function publishNoteActions(req, res, next) {
  findNote(req, res, function (note) {
    const action = req.params.action
    switch (action) {
      case 'download':
        actionDownload(req, res, note)
        break
      case 'edit':
        res.redirect(config.serverURL + '/' + (note.alias ? note.alias : models.Note.encodeNoteId(note.id)))
        break
      default:
        res.redirect(config.serverURL + '/s/' + note.shortid)
        break
    }
  })
}

export function publishSlideActions(req, res, next) {
  findNote(req, res, function (note) {
    const action = req.params.action
    switch (action) {
      case 'edit':
        res.redirect(config.serverURL + '/' + (note.alias ? note.alias : models.Note.encodeNoteId(note.id)))
        break
      default:
        res.redirect(config.serverURL + '/p/' + note.shortid)
        break
    }
  })
}

export function githubActions(req, res, next) {
  const noteId = req.params.noteId
  findNote(req, res, function (note) {
    const action = req.params.action
    switch (action) {
      case 'gist':
        githubActionGist(req, res, note)
        break
      default:
        res.redirect(config.serverURL + '/' + noteId)
        break
    }
  })
}

function githubActionGist(req, res, note) {
  const code = req.query.code
  const state = req.query.state
  if (!code || !state) {
    return errorForbidden(req, res)
  } else {
    const data = {
      client_id: config.github.clientID,
      client_secret: config.github.clientSecret,
      code: code,
      state: state
    }
    const authUrl = 'https://github.com/login/oauth/access_token'
    request({
      url: authUrl,
      method: 'POST',
      json: data
    }, function (error, httpResponse, body) {
      if (!error && httpResponse.statusCode === 200) {
        const accessToken = body.access_token
        if (accessToken) {
          const content = note.content
          const title = models.Note.decodeTitle(note.title)
          const filename = title.replace('/', ' ') + '.md'
          const gist = {
            files: {}
          }
          gist.files[filename] = {
            content: content
          }
          const gistUrl = 'https://api.github.com/gists';
          request({
            url: gistUrl,
            headers: {
              'User-Agent': 'CodiMD',
              Authorization: 'token ' + accessToken
            },
            method: 'POST',
            json: gist
          }, function (error, httpResponse, body) {
            if (!error && httpResponse.statusCode === 201) {
              res.setHeader('referer', '')
              res.redirect(body.html_url)
            } else {
              return errorForbidden(req, res)
            }
          })
        } else {
          return errorForbidden(req, res)
        }
      } else {
        return errorForbidden(req, res)
      }
    })
  }
}

export function gitlabActions(req, res, next) {
  const noteId = req.params.noteId
  findNote(req, res, function (note) {
    const action = req.params.action
    switch (action) {
      case 'projects':
        gitlabActionProjects(req, res, note)
        break
      default:
        res.redirect(config.serverURL + '/' + noteId)
        break
    }
  })
}

function gitlabActionProjects(req, res, note) {
  if (req.isAuthenticated()) {
    models.User.findOne({
      where: {
        id: req.user.id
      }
    }).then(function (user) {
      if (!user) {
        return errorNotFound(req, res)
      }
      const ret: any = {baseURL: config.gitlab.baseURL, version: config.gitlab.version}
      ret.accesstoken = user.accessToken
      ret.profileid = user.profileid
      request(
        config.gitlab.baseURL + '/api/' + config.gitlab.version + '/projects?membership=yes&per_page=100&access_token=' + user.accessToken,
        function (error, httpResponse, body) {
          if (!error && httpResponse.statusCode === 200) {
            ret.projects = JSON.parse(body)
            return res.send(ret)
          } else {
            return res.send(ret)
          }
        }
      )
    }).catch(function (err) {
      logger.error('gitlab action projects failed: ' + err)
      return errorInternalError(req, res)
    })
  } else {
    return errorForbidden(req, res)
  }
}

export function showPublishSlide(req, res, next) {
  const include = [{
    model: models.User,
    as: 'owner'
  }, {
    model: models.User,
    as: 'lastchangeuser'
  }]
  findNote(req, res, function (note) {
    // force to use short id
    const shortid = req.params.shortid
    if ((note.alias && shortid !== note.alias) || (!note.alias && shortid !== note.shortid)) {
      return res.redirect(config.serverURL + '/p/' + (note.alias || note.shortid))
    }
    note.increment('viewcount').then(function (note) {
      if (!note) {
        return errorNotFound(req, res)
      }
      const body = note.content
      const extracted = models.Note.extractMeta(body)
      const markdown = extracted.markdown
      const meta = models.Note.parseMeta(extracted.meta)
      const createtime = note.createdAt
      const updatetime = note.lastchangeAt
      let title = models.Note.decodeTitle(note.title)
      title = models.Note.generateWebTitle(meta.title || title)
      const data = {
        title: title,
        description: meta.description || (markdown ? models.Note.generateDescription(markdown) : null),
        viewcount: note.viewcount,
        createtime: createtime,
        updatetime: updatetime,
        body: markdown,
        theme: meta.slideOptions && utils.isRevealTheme(meta.slideOptions.theme),
        meta: JSON.stringify(extracted.meta),
        owner: note.owner ? note.owner.id : null,
        ownerprofile: note.owner ? models.User.getProfile(note.owner) : null,
        lastchangeuser: note.lastchangeuser ? note.lastchangeuser.id : null,
        lastchangeuserprofile: note.lastchangeuser ? models.User.getProfile(note.lastchangeuser) : null,
        robots: meta.robots || false, // default allow robots
        GA: meta.GA,
        disqus: meta.disqus,
        cspNonce: res.locals.nonce
      }
      res.set({
        'Cache-Control': 'private' // only cache by client
      })
      res.render('slide.ejs', data)
    }).catch(function (err) {
      logger.error(err)
      return errorInternalError(req, res)
    })
  }, include)
}
