import mongoose = require('mongoose');

let Schema = mongoose.Schema;

let songSchema = new Schema({
	vid: String, 		// 01234567
	type: String, 		// mp3
	quality: String, 	// 5-10 highestaudio
	hashedName: String,  // 01234

	download_count: Number,
	stream_count: Number,

	last_used: Date // Last streamed/downloaded
});

songSchema.virtual('hashedFullName').get(function() { return this.hashedName + '.' + this.type });

export = mongoose.model('downloads', songSchema);
