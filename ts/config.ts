import fs = require('fs');
import path = require('path');

const CONFIG_PATH = path.join(__dirname, '../app/config.json');

const DEFAULT_CONFIG: Config = {
	web_port: 6654,

	youtube_api_key: "",
	mongo_db: "mongodb://127.0.0.1:27017/ytdl"
};


if (!fs.existsSync(CONFIG_PATH)) {
	fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 4), 'utf-8');
}



const CONFIG: Config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));

if (CONFIG.youtube_api_key.length == 0) {
	throw new Error("Please fill in the empty values in the config file located in ./app/config.json.");

}

interface Config {
	web_port: number;
	youtube_api_key: string;
	mongo_db: string;
}

export = CONFIG;