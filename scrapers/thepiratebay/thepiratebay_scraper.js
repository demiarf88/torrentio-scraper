const moment = require('moment');
const Bottleneck = require('bottleneck');
const thepiratebay = require('./thepiratebay_api.js');
const { Type } = require('../../lib/types');
const repository = require('../../lib/repository');
const {
  createTorrentEntry,
  createSkipTorrentEntry,
  getStoredTorrentEntry,
  updateTorrentSeeders
} = require('../../lib/torrentEntries');

const NAME = 'ThePirateBay';
const UNTIL_PAGE = 20;

const limiter = new Bottleneck({ maxConcurrent: 40 });

const allowedCategories = [
  thepiratebay.Categories.VIDEO.MOVIES,
  thepiratebay.Categories.VIDEO.MOVIES_HD,
  thepiratebay.Categories.VIDEO.MOVIES_DVDR,
  thepiratebay.Categories.VIDEO.MOVIES_3D,
  thepiratebay.Categories.VIDEO.TV_SHOWS,
  thepiratebay.Categories.VIDEO.TV_SHOWS_HD
];
const seriesCategories = [
  thepiratebay.Categories.VIDEO.TV_SHOWS,
  thepiratebay.Categories.VIDEO.TV_SHOWS_HD
];

async function scrape() {
  const scrapeStart = moment();
  const lastScrape = await repository.getProvider({ name: NAME });
  console.log(`[${scrapeStart}] starting ${NAME} scrape...`);

  const latestTorrents = await getLatestTorrents();
  return Promise.all(latestTorrents.map(torrent => limiter.schedule(() => processTorrentRecord(torrent))))
      .then(() => {
        lastScrape.lastScraped = scrapeStart;
        lastScrape.lastScrapedId = latestTorrents.length && latestTorrents[latestTorrents.length - 1].torrentId;
        return repository.updateProvider(lastScrape);
      })
      .then(() => console.log(`[${moment()}] finished ${NAME} scrape`));
}

async function getLatestTorrents() {
  return Promise.all(allowedCategories.map(category => getLatestTorrentsForCategory(category)))
      .then(entries => entries.reduce((a, b) => a.concat(b), []));
}

async function getLatestTorrentsForCategory(category, page = 0) {
  return thepiratebay.browse(({ category, page }))
      .then(torrents => torrents.length && page < UNTIL_PAGE
          ? getLatestTorrents(category, page + 1).then(nextTorrents => torrents.concat(nextTorrents))
          : torrents)
      .catch(() => []);
}

async function processTorrentRecord(record) {
  if (await getStoredTorrentEntry(record)) {
    return updateTorrentSeeders(record);
  }

  const torrentFound = await thepiratebay.torrent(record.torrentId).catch(() => undefined);

  if (!torrentFound || !allowedCategories.includes(torrentFound.subcategory)) {
    return createSkipTorrentEntry(record);
  }

  const torrent = {
    infoHash: torrentFound.infoHash,
    provider: NAME,
    torrentId: torrentFound.torrentId,
    title: torrentFound.name.replace(/\t|\s+/g, ' '),
    size: torrentFound.size,
    type: seriesCategories.includes(torrentFound.subcategory) ? Type.SERIES : Type.MOVIE,
    imdbId: torrentFound.imdbId,
    uploadDate: torrentFound.uploadDate,
    seeders: torrentFound.seeders,
  };

  return createTorrentEntry(torrent);
}

module.exports = { scrape };