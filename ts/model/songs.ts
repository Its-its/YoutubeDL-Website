import mongoose = require('mongoose');

let Schema = mongoose.Schema;

let songSchema = new Schema({
	type: Number,

	title: String,
	vid: String,
	description: String,
	thumbnail_url: String,

	length: Number,
	published: Number,
	view_count: Number,

	channel_id: String,

	download_count: Number,
	stream_count: Number,

	last_updated: Date
});

songSchema.virtual('hashedFullName').get(function() { return this.hashedName + '.' + this.type });

export = mongoose.model('songs', songSchema);
