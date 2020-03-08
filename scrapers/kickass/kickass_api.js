const cheerio = require('cheerio');
const needle = require('needle');
const moment = require('moment');
const decode = require('magnet-uri');

const defaultProxies = [
  'https://katcr.co'
];
const defaultTimeout = 10000;

const Categories = {
  MOVIE: 'movies',
  TV: 'tv',
  ANIME: 'anime',
  APPS: 'applications',
  GAMES: 'games',
  MUSIC: 'music',
  BOOKS: 'books',
  PORN: 'xxx',
  OTHER: 'other',
};

function torrent(torrentId, config = {}, retries = 2) {
  if (!torrentId || retries === 0) {
    return Promise.reject(new Error(`Failed ${torrentId} search`));
  }
  const proxyList = config.proxyList || defaultProxies;

  return raceFirstSuccessful(proxyList
      .map((proxyUrl) => singleRequest(`${proxyUrl}/torrent/${torrentId}`, config)))
      .then((body) => parseTorrentPage(body))
      .then((torrent) => ({ torrentId, ...torrent }))
      .catch((err) => torrent(torrentId, config, retries - 1));
}

function search(keyword, config = {}, retries = 2) {
  if (!keyword || retries === 0) {
    return Promise.reject(new Error(`Failed ${keyword} search`));
  }
  const proxyList = config.proxyList || defaultProxies;
  const page = config.page || 1;
  const category = config.category;

  return raceFirstSuccessful(proxyList
      .map((proxyUrl) => singleRequest(`${proxyUrl}/search/${keyword}/${page}/99/${category}`, config)))
      .then((body) => parseTableBody(body))
      .catch((err) => search(keyword, config, retries - 1));
}

function browse(config = {}, retries = 2) {
  if (retries === 0) {
    return Promise.reject(new Error(`Failed browse request`));
  }
  const proxyList = config.proxyList || defaultProxies;
  const page = config.page || 1;
  const category = config.category;

  return raceFirstSuccessful(proxyList
      .map((proxyUrl) => singleRequest(`${proxyUrl}/category/${category}/page/${page}`, config)))
      .then((body) => parseTableBody(body))
      .catch((err) => browse(config, retries - 1));
}

function singleRequest(requestUrl, config = {}) {
  const timeout = config.timeout || defaultTimeout;

  return needle('get', requestUrl, { open_timeout: timeout, follow: 2 })
      .then((response) => {
        const body = response.body;
        if (!body) {
          throw new Error(`No body: ${requestUrl}`);
        } else if (body.includes('Access Denied')) {
          console.log(`Access Denied: ${requestUrl}`);
          throw new Error(`Access Denied: ${requestUrl}`);
        } else if (body.includes('502: Bad gateway') ||
            body.includes('403 Forbidden') ||
            body.includes('Origin DNS error') ||
            !body.includes('Kickass Torrents</title>')) {
          throw new Error(`Invalid body contents: ${requestUrl}`);
        }
        return body;
      });
}

function parseTableBody(body) {
  return new Promise((resolve, reject) => {
    const $ = cheerio.load(body);

    if (!$) {
      reject(new Error('Failed loading body'));
    }

    const torrents = [];

    $('.table > tbody > tr').each((i, element) => {
      const row = $(element);
      torrents.push({
        torrentId: row.find('a[class="torrents_table__torrent_title"]').first().attr('href').replace('/torrent/', ''),
        name: row.find('a[class="torrents_table__torrent_title"]').first().children('b').text(),
        category: row.find('span[class="torrents_table__upload_info"]').first().children('a').first().attr('href')
            .match(/category\/([^\/]+)/)[1],
        seeders: parseInt(row.find('td[data-title="Seed"]').first().text()),
        leechers: parseInt(row.find('td[data-title="Leech"]').first().text()),
        size: parseSize(row.find('td[data-title="Size"]').first().text()),
        uploadDate: moment(row.find('td[data-title="Age"]').first().attr('title')).toDate()
      });
    });

    resolve(torrents);
  });
}

function parseTorrentPage(body) {
  return new Promise((resolve, reject) => {
    const $ = cheerio.load(body);

    if (!$) {
      reject(new Error('Failed loading body'));
    }
    const content = $('div[class="col"]').first();
    const info = content.find('div[class="torrent_stats"]').parent();
    const description = content.find('div[id="main"]');
    const magnetLink = info.find('a[title="Download verified Magnet"]').attr('href');
    const imdbIdMatch = description.html().match(/imdb\.com\/title\/tt(\d+)/i);

    const torrent = {
      name: info.find('h1').first().text(),
      infoHash: decode(magnetLink).infoHash,
      magnetLink: magnetLink,
      seeders: parseInt(info.find('span[class="torrent_stats__seed_count mr-2"]').first().text().match(/\d+/)[0], 10),
      leechers: parseInt(info.find('span[class="torrent_stats__leech_count mr-2"]').first().text().match(/\d+/)[0], 10),
      category: info.find('small').first().children('a').first().attr('href').match(/\/category\/([^\/]+)/)[1],
      language: description.find('span:contains(\'Audio\')').next().children().eq(0).text(),
      size: parseSize(description.find('ul[class="file_list"]').first().find('li').first().contents().eq(2).text()
          .match(/\(Size: (.+)\)/)[1]),
      uploadDate: moment(info.find('time').first().text()).toDate(),
      imdbId: imdbIdMatch && `tt${imdbIdMatch[1].padStart(7, '0')}`,
      files: content.find('ul[class="file_list"]').first().find('li > ul > li[class="file_list__file"]')
          .map((i, elem) => $(elem))
          .map((i, ele) => ({
            fileIndex: i,
            name: ele.find('span > ul > li').contents().eq(1).text().trim().replace(/^.+\//g, ''),
            path: ele.find('span > ul > li').contents().eq(1).text().trim(),
            size: parseSize(ele.contents().eq(2).text())
          })).get()
    };
    if (torrent.files.length >= 50) {
      // a max of 50 files are displayed on the page
      delete torrent.files;
    }
    resolve(torrent);
  });
}

function parseSize(sizeText) {
  if (!sizeText) {
    return undefined;
  }
  let scale = 1;
  if (sizeText.includes('GB')) {
    scale = 1024 * 1024 * 1024
  } else if (sizeText.includes('MB')) {
    scale = 1024 * 1024;
  } else if (sizeText.includes('KB') || sizeText.includes('kB')) {
    scale = 1024;
  }
  return Math.floor(parseFloat(sizeText.replace(/[',]/g, '')) * scale);
}

function raceFirstSuccessful(promises) {
  return Promise.all(promises.map((p) => {
    // If a request fails, count that as a resolution so it will keep
    // waiting for other possible successes. If a request succeeds,
    // treat it as a rejection so Promise.all immediately bails out.
    return p.then(
        (val) => Promise.reject(val),
        (err) => Promise.resolve(err)
    );
  })).then(
      // If '.all' resolved, we've just got an array of errors.
      (errors) => Promise.reject(errors),
      // If '.all' rejected, we've got the result we wanted.
      (val) => Promise.resolve(val)
  );
}

module.exports = { torrent, search, browse, Categories };
