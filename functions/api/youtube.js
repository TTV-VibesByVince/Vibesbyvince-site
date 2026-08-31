// Cloudflare Pages Function — GET /api/youtube
//
// Reads a YouTube channel's public RSS feed server-side and returns the
// most recent video as JSON. Doing this in a Function (instead of straight
// from the browser) avoids CORS issues, since youtube.com doesn't send
// Access-Control-Allow-Origin headers on that feed.
//
// SETUP: replace CHANNEL_ID below with your actual YouTube channel ID
// (starts with "UC..."). Find it at:
//   YouTube Studio -> Settings -> Channel -> Advanced settings -> Channel ID
// (Your @handle won't work here — YouTube's RSS feed requires the ID.)

const CHANNEL_ID = 'UCyqkH9sniDc1bEQwDcpky9w';

export async function onRequestGet() {
  try {
    const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}`;
    const feedRes = await fetch(feedUrl, {
      cf: { cacheTtl: 1800, cacheEverything: true },
    });

    if (!feedRes.ok) {
      throw new Error(`feed fetch failed: ${feedRes.status}`);
    }

    const xml = await feedRes.text();
    const entryMatch = xml.match(/<entry>([\s\S]*?)<\/entry>/);
    if (!entryMatch) throw new Error('no entries in feed');

    const entry = entryMatch[1];
    const videoId = firstMatch(entry, /<yt:videoId>(.*?)<\/yt:videoId>/);
    const title = firstMatch(entry, /<media:title>(.*?)<\/media:title>/) || firstMatch(entry, /<title>(.*?)<\/title>/);
    const thumbnail = firstMatch(entry, /<media:thumbnail url="(.*?)"/);

    if (!videoId) throw new Error('no video id found');

    const data = {
      id: videoId,
      title: decodeXmlEntities(title || 'watch latest video'),
      url: `https://www.youtube.com/watch?v=${videoId}`,
      thumbnail: thumbnail || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    };

    return json(data, 200, 'public, max-age=600, s-maxage=1800');
  } catch (err) {
    return json({ error: true, message: String(err) }, 200, 'public, max-age=60');
  }
}

function firstMatch(str, regex) {
  const m = str.match(regex);
  return m ? m[1] : null;
}

function decodeXmlEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function json(data, status, cacheControl) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': cacheControl,
    },
  });
}
