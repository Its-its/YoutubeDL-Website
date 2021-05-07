import path = require('path');
import fs = require('fs');
import { PassThrough, Writable } from 'stream';

import md5 = require('md5');
import express = require('express');
import bodyParser = require('body-parser');
import cookieParser = require('cookie-parser');
import ffmeg = require('fluent-ffmpeg');
import YouTube = require('youtube-node');
import youtubedl = require('ytdl-core');
import mongoose = require('mongoose');

import config = require('./config');

import Songs = require('./model/songs');
import Downloaded = require('./model/downloaded');

mongoose.Promise = global.Promise;
mongoose.connect(config.mongo_db)
.then(() => console.log('Connected to DB'),  err => console.error(err));

// @ts-ignore
const YOUTUBE = new YouTube();
YOUTUBE.setKey(config.youtube_api_key);

const DOWNLOAD_LOCATION = path.join(__dirname, '../app/audio');

if (!fs.existsSync(DOWNLOAD_LOCATION)) {
	fs.mkdirSync(DOWNLOAD_LOCATION);
}

let app = express();

app.set('port', config.web_port);

app.use(express.static(path.join(__dirname, '../app/public')));

app.use(cookieParser());

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

app.get('/', (req, res) => {
	res.sendFile(path.join(__dirname, '../app/views/index.html'));
});


app.get('/tag/:name', (req, res) => {
	res.sendFile(path.join(__dirname, '../app/views/tagger.html'));
});



app.post('/tag', (req, res) => {
	var hash = req.body.hash;

	Downloaded.findOne({ hashedName: hash }, (err, item) => {
		if (err != null || item == null) {
			res.send({ error: 'An Error Occured!' });
			if (err != null) return console.error(err);
			if (item == null) return console.error('Downloaded item not found.');
		}

		Songs.findOne({ vid: item['vid'] }, (err, song) => {
			if (err != null || item == null) {
				res.send({ error: 'An Error Occured!' });
				if (err != null) return console.error(err);
				if (song == null) return console.error('Song not found.');
			}

			res.send({ title: song['title'] });
		})
	});
});

app.get('/stream', (req, res) => {
	var queryId: string = req.query.id;
	var from = req.query.t == null ? null : toSeconds(req.query.t);

	var formatType: string = 'mp3';//req.body.format;
	var quality = 'highestaudio';//req.body.quality || 5;

	if (queryId == null) return res.status(500).send({ error: 'Youtube ID not assigned.' });

	var regExp = /([A-Za-z0-9_-]{11,})/;

	if (!regExp.test(queryId)) return res.status(500).send({ error: 'Youtube ID Not Valid.' });

	var vid = regExp.exec(queryId)[1];

	var fileHash = md5(vid + '_' + quality);
	var fullFileName = fileHash + '.' + formatType;

	var filePath = path.join(DOWNLOAD_LOCATION, fullFileName);

	fs.stat(filePath, (err, stats) => {
		if (err != null) {
			console.log('New: ' + fullFileName);

			downloadSong(vid, quality, formatType, (err, resp) => {
				if (err != null) {
					console.error(err);
					return res.status(500).send({ error: err });
				}

				Songs.updateOne({ hashedName: fileHash }, { $inc: { stream_count: 1 } }).exec();
				Downloaded.updateOne({ hashedName: fileHash }, { $inc: { stream_count: 1 }, $set: { last_used: Date.now() } }).exec();

				res.contentType('audio/' + formatType);
				resp.pass.pipe(res);
			});
		} else {
			console.log('Exists');

			Songs.updateOne({ hashedName: fileHash }, { $inc: { stream_count: 1 } }).exec();
			Downloaded.updateOne({ hashedName: fileHash }, { $inc: { stream_count: 1 }, $set: { last_used: Date.now() } }).exec();

			var total = stats.size;

			if (req.headers.range != null) {
				var range = req.headers.range;
				var parts = (typeof range == 'string' ? range : range.join('')).replace(/bytes=/, '').split('-');
				var partialstart = parts[0];
				var partialend = parts[1];

				var start = parseInt(partialstart, 10);
				var end = partialend ? parseInt(partialend, 10) : total - 1;

				if (isNaN(start) || isNaN(end)) return res.end();

				var chunksize = (end - start) + 1;

				var readStream = fs.createReadStream(filePath, { start: start, end: end });

				res.writeHead(206, {
					'Content-Range': 'bytes ' + start + '-' + end + '/' + total,
					'Accept-Ranges': 'bytes', 'Content-Length': chunksize,
					'Content-Type': 'audio/' + formatType
				});

				readStream.pipe(res);
			} else {
				res.writeHead(200, { 'Content-Length': total, 'Content-Type': 'audio/' + formatType });
				fs.createReadStream(filePath).pipe(res);
			}

			// if (from == null) {
			// 	fs.createReadStream(filePath).pipe(res);
			// } else {
			// 	ffmeg(fs.createReadStream(filePath))
			// 	.seek(from)
			// 	.pipe(res, { end: true });
			// }
		}
	})
});

app.post('/download', (req, res) => {
	let title: string = String(req.body.title || '').trim();
	let artist: string = String(req.body.artist || '').trim();
	let hash: string = req.body.hash;

	if (title.length == 0 && artist.length == 0) return res.send({ error: 'Title and Artist cannot be empty!' });
	if (hash == null) return res.send({ error: 'Song hash not defined!' });

	Downloaded.findOneAndUpdate(
		{ hashedName: hash },
		{ $inc: { download_count: 1 }, $set: { last_used: Date.now() } },
	(err, item: any) => {
		if (err != null || item == null) {
			res.send({ error: 'Media not found! Please try again or refresh the page in a couple seconds.' });
			if (err != null) return console.error(err);
			if (item == null) return console.error('Item not found.');
		}

		Songs.updateOne({ vid: item.vid }, { $inc: { download_count: 1 } }).exec();
		// Downloaded.updateOne({ hashedName: hash }, { $inc: { download_count: 1 }, $set: { last_used: Date.now() } }).exec();

		var compiled = [];
		if (artist.length != 0) compiled.push(artist);
		if (title.length != 0) compiled.push(title);

		res.attachment(compiled.join(' - ') + '.' + item['type']);
		res.contentType('audio/' + item['type']);

		ffmeg(path.join(DOWNLOAD_LOCATION, item['hashedFullName']))
		.format(item['type'])
		.outputOptions(...metaToOptionsArray({
			title: title,
			artist: artist
		}))
		.writeToStream(res, { end: true });
	});
});

app.get('/info', (req, res) => {
	var force = req.query.force == null ? false : (req.query.force == 'true');
	var compact = req.query.compact == null ? false : (req.query.compact == 'true');

	var querySearch: string = req.query.search;

	if (querySearch != null) {
		force = true;

		YOUTUBE.search(querySearch, 4, { type: 'video' }, (err, searched) => {
			if (err != null) {
				res.status(500).send({ error: 'An error occured while trying to search for the video. Please try again in a few moments.' });
				return console.error(err);
			}

			var items = searched.items;

			for(var i = 0; i < items.length; i++) {
				var item = items[i];

				if (item.id != null && item.id.kind == 'youtube#video') {
					return searchFromID([item.id.videoId]);
				}
			}

			res.status(500).send({ error: 'Unable to find video.' });
		});

		return;
	}


	var queryIds = req.query.id;

	if (queryIds == null || queryIds.length == 0) return res.status(500).send({ error: 'Youtube ID not assigned.' });
	queryIds = queryIds.split(',').slice(0, 20);

	var regExp = /([A-Za-z0-9_-]{11,})/;

	var invalidIds = [];

	for(var i = 0; i < queryIds.length; i++) {
		if (!regExp.test(queryIds[i])) invalidIds.push(queryIds[i]);

		queryIds[i] = regExp.exec(queryIds[i])[1];
	}

	if (invalidIds.length != 0) return res.status(500).send({ error: 'One or more Youtube ids are not Valid. [' + invalidIds.join(',') + ']' });

	searchFromID(queryIds);

	function searchFromID(ids: string[]) {
		// Remove duplicates
		ids = ids.filter((item, pos) => ids.indexOf(item) == pos);

		Songs.find({ vid: { $in: ids } }, (err, songs) => {
			if (err != null) {
				res.status(500).send({ error: 'An error occured while trying to find the song. Please try again in a few moments.' });
				return console.error(err);
			}

			if (songs.length == 0) {
				if (!force) {
					res.status(500).send({ error: 'Song not found. Possibly never streamed/downloaded?' });
					return console.error('Song not found.');
				}

				getSongInfo(ids[0], (err, info) => {
					if (err != null) {
						res.status(500).send({ error: 'An error occured while trying to find the song info. Please try again in a few moments.' });
						return console.error(err);
					}

					var ret = {
						id: info.vid,
						title: info.title,
						length: info.length,
						published: info.published,
						download_count: info.download_count,
						stream_count: info.stream_count,
						thumbnail_url: info.thumbnail_url,
						view_count: info.view_count,
						channel_id: info.channel_id
					};

					if (!compact) ret['description'] = info.description;

					res.send(ret);
				});

				return;
			} else {
				for(var i = 0; i < songs.length; i++) {
					if (songs[i] == null) return res.status(500).send({ error: 'One or more songs not found. Possibly never streamed/downloaded?' });
				}
			}

			var items = songs.map(song => {
				var item = {
					id: song['vid'],
					title: song['title'],
					length: song['length'],
					published: song['published'],
					thumbnail_url: song['thumbnail_url'],
					view_count: song['view_count'],
					download_count: song['download_count'],
					stream_count: song['stream_count'],
					channel_id: song['channel_id']
				};

				if (!compact) item['description'] = song['description'];

				return item;
			});

			res.send({ songs: items });
		});
	}
});


app.get('/search', (req, res) => {
	var query = req.query.query;
	var pageToken = req.query.pageToken;

	if (query == null) return res.send({ error: 'Please include a search query.' });

	var opts = { type: 'video' };

	if (pageToken != null) opts['pageToken'] = pageToken;

	YOUTUBE.search(query, 5, opts, (err, found) => {
		if (err != null) {
			res.status(500).send({ error: 'An error occured while trying to search for the video. Please try again in a few moments.' });
			return console.error(err);
		}

		var items = found.items;//.filter(i => i.id == null || i.id.kind != 'youtube#video');

		res.send({
			nextPageToken: found.nextPageToken,
			previousPageToken: found.previousPageToken,
			totalResults: found.pageInfo.totalResults,
			resultsPerPage: found.pageInfo.resultsPerPage,

			items: items.map(i => {
				return {
					type: i.id.kind,
					id: i.id.videoId,
					published: new Date(i.snippet.publishedAt).getTime(),
					title: i.snippet.title,
					channel: {
						id: i.snippet.channelId,
						title: i.snippet.channelTitle
					},
					thumbnail: i.snippet.thumbnails.default
				}
			})
		});
	});
});


app.post('/convert', (req, res) => {
	let id: string = req.body.id;
	let type: string = req.body.format;
	let quality = 'highestaudio';

	if (getFormat(type) == null) return res.send('Invalid Type!');

	let reg = /([A-Za-z0-9_-]{11,})/;

	if (!reg.test(id)) return res.send('Not Valid.');


	let fileHash = md5(id + '_' + quality);
	let fullFileName = fileHash + '.' + type;

	let vid = reg.exec(id)[1];

	Songs.findOne({ hashedName: fileHash }, (err, item) => {
		if (err != null) {
			res.send('[e] Error occured when checking database!');
			return console.error(err);
		}

		if (item != null) return res.send('[r] tag/' + fileHash);

		downloadSong(vid, quality, type, (err, resp) => {
			res.contentType('audio/' + type);

			if (err != null) {
				console.error(err);
				return res.end();
			}

			resp.ffmeg
			.on('end', () => {
				res.write('[r] tag/' + fileHash);
				res.end();
			})
			.on('error', (err) => {
				console.error(err);
				res.write('[e] Error formatting to mp3');
			})
			.on('progress', (progress) => {
				if (!res.finished) res.write('[p] ' + progress.timemark);
			});
		});
	});
});


interface SongInfo {
	vid: string;
	title: string;
	description: string;
	thumbnail_url: string;

	length: number;
	view_count: number;
	published: number;
	download_count: number;
	stream_count: number;

	channel_id: string;
}

function getSongInfo(id: string, cb: (err?: Error, song?: SongInfo) => any) {
	youtubedl.getInfo(id, (err, info) => {
		if (err != null) return cb(err);

		var length = parseInt(info.length_seconds);

		if (isNaN(length)) {
			return cb(new Error('Unable to get video length!'));
		} else if (length > (60 * 60 * 60 * 4.2)) return cb(new Error('Song Longer than 4.2 hours!'));

		Songs.updateOne({
			vid: id
		}, {
			$setOnInsert: {
				vid: id,
				type: 0,
				channel_id: info.author.id,
				published: info.published,
				download_count: 0,
				stream_count: 0
			},

			$set: {
				title: info.title,
				length: length,
				description: info.description,
				thumbnail_url: info.thumbnail_url,
				view_count: parseInt(info.player_response.videoDetails.viewCount),
				last_updated: Date.now()
			}
		}, { upsert: true })
		.exec();

		cb(null, {
			vid: id,
			title: info.title,
			length: length,
			description: info.description,
			published: info.published,
			thumbnail_url: info.thumbnail_url,
			channel_id: info.author.id,
			view_count: parseInt(info.player_response.videoDetails.viewCount),
			download_count: 0,
			stream_count: 0
		});
	});
}

interface DownloadedInfo {
	pass: PassThrough;
	ffmeg: ffmeg.FfmpegCommand;
	pipe: Writable;
	info: {
		id: string;
		type: string;
		quality: string;
		hashedName: string;
		title: string;
		length: number;
		thumbnail_url: string;
		view_count: number;
		description: string;
		published: number;
		download_count: number;
		stream_count: number;
	}
}

function downloadSong(id: string, quality: string, format: string, cb: (err?: Error, info?: DownloadedInfo) => any) {
	getSongInfo(id, (err, info) => {
		if (err != null) return cb(err);

		var fileHash = md5(id + '_' + quality);
		var fullFileName = fileHash + '.' + format;

		var filePath = path.join(DOWNLOAD_LOCATION, fullFileName);

		const ytStream = youtubedl(id, { quality: quality });
		const pass = new PassThrough();

		var peg = ffmeg(ytStream);
		var pipe = peg.audioCodec('libmp3lame').format(format).pipe(pass);

		pipe.on('end', () => console.log('end'));
		pipe.on('error', (err) => console.error(err));

		pass.pipe(fs.createWriteStream(filePath));

		new Downloaded({
			vid: id,
			type: format,
			quality: quality,
			hashedName: fileHash,
			download_count: 0,
			stream_count: 0,
			last_used: Date.now()
		}).save();

		return cb(null, {
			pass: pass,
			ffmeg: peg,
			pipe: pipe,
			info: {
				id: id,
				type: format,
				quality: quality,
				hashedName: fileHash,
				title: info.title,
				length: info.length,
				description: info.description,
				thumbnail_url: info.thumbnail_url,
				view_count: info.view_count,
				published: info.published,
				download_count: 0,
				stream_count: 0
			}
		});
	});
}

const audioFormats = [ 'mp3', 'flv', 'wav', 'ogg', 'm4a', 'aac' ];
const videoFormats = [ 'mp4', 'webm', '3gp' ];
const downloadEnum = { 'youtube': 0 };

function isSupported(format) {
	if (audioFormats.indexOf(format) != -1) return true;
	if (videoFormats.indexOf(format) != -1) return true;
	return false;
}

function getFormat(format) {
	if (audioFormats.indexOf(format) != -1) return 'audio';
	if (videoFormats.indexOf(format) != -1) return 'video';
	return null;
}

function metaToOptionsArray(meta: { [key: string]: any }): any[] {
	let arr = [];

	Object.keys(meta)
	.forEach(key => {
		arr.push('-metadata');
		arr.push(`${ key }=${ typeof meta[key] == 'string' ? meta[key] : meta[key].join(';') }`);
	});

	return arr;
}

function toSeconds(str: string): number {
	var parsed = parseInt(str);
	if (isNaN(parsed)) return null;

	// TODO: str == 10m5s

	return parsed;
}

app.listen(app.get('port'), () => console.log('Server started on localhost:' + app.get('port')));