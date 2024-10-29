import dotenv from 'dotenv';
import axios from 'axios';
import fs from 'fs/promises';

dotenv.config();
const logFilePath = 'system.log';
const apiKey = process.env.API_KEY;
const discord_url = process.env.DISCORD_WEBHOOK;
const roles = process.env.ROLES ? JSON.parse(process.env.ROLES) : [];
const channel_ids = Object.keys(roles);

import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function getLogFilePath(date) {
	const options = { year: '2-digit', month: '2-digit', day: '2-digit', timeZone: 'Asia/Bangkok' };
	const dateString = date.toLocaleDateString('en-US', options).replace(/\//g, '-');
	return path.join(__dirname, 'log', 'system', `${dateString}.log`);
}

function logMessage(message) {
	const now = new Date();
	const options = {
		timeZone: 'Asia/Bangkok',
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		hour12: false
	};
	const timeString = now.toLocaleString('en-US', options).replace(',', '');
	const stack = new Error().stack.split("\n")[2].trim();
	const functionName = stack.split(" ")[1];
	const logEntry = `[${timeString}] (${functionName}) - ${message}\n`;

	const logFilePath = getLogFilePath(now);
	fs.appendFile(logFilePath, logEntry).catch(err => {
		console.error('Error writing to log file:', err);
	});
}

async function getRSS(channel) {
    const feed_url = 'https://www.youtube.com/feeds/videos.xml?channel_id=' + channel;
    try {
        const response = await axios.get(feed_url);
        const xmlData = response.data;
        const videoIdMatch = xmlData.match(/<yt:videoId>([^<]+)<\/yt:videoId>/);

        if (videoIdMatch) {
            return videoIdMatch[1];
        } else {
            logMessage('No videos found');
            return false;
        }
    } catch (error) {
        logMessage('Error fetching RSS feed: ' + error);
        return false;
    }
}

async function getVidsDetails(vIds) {
    try {
        const url = `https://www.googleapis.com/youtube/v3/videos?id=${vIds.join(',')}&part=snippet,liveStreamingDetails&key=${apiKey}`;
        const response = await axios.get(url);
        const videos = response.data.items;

        let videos_data = {
            'upcoming': [],
            'live': {},
            'none': {}
        };

        if (videos && videos.length > 0) {
            videos.forEach(video => {
                if (video.liveStreamingDetails) {
                    if (video.snippet.liveBroadcastContent === 'upcoming') {
                        videos_data['upcoming'].push(video.id);
                    } else if (video.snippet.liveBroadcastContent === 'live') {
                        videos_data['live'][video.id] = {
                            channelId: video.snippet.channelId,
                            title: video.snippet.title
                        };
                    }
                } else {
                    let publishedTime = new Date(video.snippet.publishedAt).getTime();
                    if (Date.now() - publishedTime < 55000) {
                        videos_data['none'][video.id] = {
                            channelId: video.snippet.channelId
                        };
                    }
                }
            });
            return videos_data;
        } else {
            logMessage('No videos found');
            return {};
        }
    } catch (error) {
        logMessage('Error checking video status: ' + error);
        return {};
    }
}

async function getUpcomingVids() {
    let data = [];
    try {
        let fileContent = await fs.readFile('data.json', 'utf8');
        data = JSON.parse(fileContent);
    } catch (error) {
        logMessage('Error reading data.json: ' + error);
        data = [];
    }
    return data;
}

async function sendNotify(cId, vId, title = '') {
    let mentionTo = '';
    for (let channelId in roles) {
        if (cId === channelId) {
            mentionTo += roles[channelId].role_id;
        }
        if (title.includes(roles[channelId].username)) {
            mentionTo += ` ${roles[channelId].role_id}`;
        }
    }

    let msg = `${mentionTo} \n https://youtu.be/${vId}`;
    try {
        const response = await axios.post(discord_url, {
            content: msg,
        }, {
            headers: {
                'Content-Type': 'application/json',
            }
        });

        if (response.status !== 204) {
            logMessage(`Error sending webhook: ${response.status} - ${response.statusText}`);
        } else {
            logMessage(`Webhook sent successfully: ${msg}`);
        }
    } catch (error) {
        logMessage('Error sending webhook: ' + error);
    }
}

async function script() {
    try {
        let latestIds = await Promise.all(channel_ids.map(channel_id => getRSS(channel_id)));
        let inList = await getUpcomingVids();
        let idsToCheck = [...new Set([...inList, ...latestIds])];
        let v = await getVidsDetails(idsToCheck);
        let update = false;

        if (Object.keys(v).length === 0) {
            return;
        }
        //console.log(v);
        if (v.upcoming.length > 0) {
            inList = [...new Set([...inList, ...v.upcoming])];
            update = true;
        }

        if (Object.keys(v.live).length > 0) {
            let live_v = v.live;
            for (let id in live_v) {
                let channelId = live_v[id].channelId;
                let title = live_v[id].title;
                if (inList.includes(id)) {
                    await sendNotify(channelId, id, title);
                    inList = inList.filter(item => item !== id);
                    update = true;
                }
            }
        }

        if (Object.keys(v.none).length > 0) {
            let none_v = v.none;
            for (let id in none_v) {
                let channelId = none_v[id].channelId;
                await sendNotify(channelId, id);
            }
        }

        if (update) {
            await fs.writeFile('data.json', JSON.stringify(inList), 'utf8');
        }
    } catch (error) {
        logMessage('Error in script: ' + error);
    }
}

script();