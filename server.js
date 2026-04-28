const ytDlp = require('yt-dlp-exec');
const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const http = require('http');
const archiver = require('archiver');

const app = express();
const PORT = 4000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));


function sanitizeFilename(name) {
    return name
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 200);
}

// Generic fetch helper (no external deps)
function fetchJSON(url, options = {}) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const lib = parsed.protocol === 'https:' ? https : http;
        const reqOptions = {
            hostname: parsed.hostname,
            path: parsed.pathname + parsed.search,
            headers: {
                'User-Agent': 'yt-dlp-server/1.0 (music metadata fetcher)',
                'Accept': 'application/json',
                ...options.headers,
            },
        };
        const req = lib.get(reqOptions, (res) => {
            let data = '';
            res.on('data', (chunk) => (data += chunk));
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode, body: JSON.parse(data) });
                } catch {
                    resolve({ status: res.statusCode, body: data });
                }
            });
        });
        req.on('error', reject);
        req.setTimeout(8000, () => { req.destroy(); reject(new Error('Timeout')); });
    });
}

// Check if a URL actually returns an image
function checkImageUrl(url) {
    return new Promise((resolve) => {
        try {
            const parsed = new URL(url);
            const lib = parsed.protocol === 'https:' ? https : http;
            const req = lib.request(
                { hostname: parsed.hostname, path: parsed.pathname + parsed.search, method: 'HEAD' },
                (res) => {
                    const ct = res.headers['content-type'] || '';
                    resolve(res.statusCode === 200 && ct.startsWith('image/'));
                }
            );
            req.on('error', () => resolve(false));
            req.setTimeout(5000, () => { req.destroy(); resolve(false); });
            req.end();
        } catch {
            resolve(false);
        }
    });
}

// Parse "Artist - Title" or just "Title" from a yt-dlp title string
function parseArtistTitle(rawTitle, uploader) {
    // Common patterns: "Artist - Title", "Artist – Title", "Artist — Title"
    const match = rawTitle.match(/^(.+?)\s*[-–—]\s*(.+)$/);
    if (match) {
        return { artist: match[1].trim(), title: match[2].trim() };
    }
    // Fallback: uploader as artist
    return { artist: uploader || '', title: rawTitle.trim() };
}

// Strip junk from song titles (Official Video, lyrics, HD, etc.)
function cleanTitle(title) {
    return title
        .replace(/\(?(official\s*(music\s*)?video|official\s*audio|lyrics?(\s*video)?|HD|HQ|4K|visualizer|audio)\)?/gi, '')
        .replace(/\[.*?\]/g, '')
        .replace(/\(.*?\)/g, '')
        .trim();
}

// 1. MusicBrainz search → returns recording + release info
async function searchMusicBrainz(artist, title) {
    try {
        const q = encodeURIComponent(`recording:"${title}" AND artist:"${artist}"`);
        const url = `https://musicbrainz.org/ws/2/recording?query=${q}&limit=5&fmt=json`;
        const { body } = await fetchJSON(url);
        if (!body?.recordings?.length) return null;

        const recording = body.recordings[0];
        const release = recording.releases?.[0];
        const releaseGroup = release?.['release-group'];

        return {
            mbid: recording.id,
            title: recording.title,
            artist: recording['artist-credit']?.[0]?.name || artist,
            artistMbid: recording['artist-credit']?.[0]?.artist?.id,
            album: release?.title || null,
            releaseId: release?.id || null,
            releaseGroupId: releaseGroup?.id || null,
            releaseGroupType: releaseGroup?.['primary-type'] || null,
            date: release?.date || recording.date || null,
            country: release?.country || null,
            trackNumber: release?.media?.[0]?.track?.[0]?.number || null,
            totalTracks: release?.media?.[0]?.['track-count'] || null,
        };
    } catch (err) {
        console.warn('MusicBrainz search failed:', err.message);
        return null;
    }
}

// 2. MusicBrainz artist lookup for extra details
async function getMusicBrainzArtist(artistMbid) {
    if (!artistMbid) return null;
    try {
        const url = `https://musicbrainz.org/ws/2/artist/${artistMbid}?inc=url-rels&fmt=json`;
        const { body } = await fetchJSON(url);
        return {
            country: body.country || body.area?.name || null,
            disambiguation: body.disambiguation || null,
            type: body.type || null,
        };
    } catch {
        return null;
    }
}

// 3. Cover Art Archive — highest resolution available for a release
async function getCoverArtArchive(releaseId, releaseGroupId) {
    const ids = [
        releaseId ? `release/${releaseId}` : null,
        releaseGroupId ? `release-group/${releaseGroupId}` : null,
    ].filter(Boolean);

    for (const id of ids) {
        try {
            const url = `https://coverartarchive.org/${id}`;
            const { body } = await fetchJSON(url);
            if (!body?.images?.length) continue;

            // Prefer front cover, fall back to first image
            const front = body.images.find((img) => img.front) || body.images[0];
            // Use the largest available thumbnail or the original
            const art =
                front.thumbnails?.['1200'] ||
                front.thumbnails?.['500'] ||
                front.thumbnails?.large ||
                front.image;

            if (art) return art;
        } catch {
            // 404s are normal
        }
    }
    return null;
}

// 4. iTunes Search API — great album art + extra metadata
async function searchItunes(artist, title) {
    try {
        const q = encodeURIComponent(`${artist} ${title}`);
        const url = `https://itunes.apple.com/search?term=${q}&media=music&limit=5`;
        const { body } = await fetchJSON(url);
        if (!body?.results?.length) return null;

        const r = body.results[0];
        return {
            album: r.collectionName || null,
            artist: r.artistName || null,
            title: r.trackName || null,
            genre: r.primaryGenreName || null,
            releaseDate: r.releaseDate ? r.releaseDate.split('T')[0] : null,
            trackNumber: r.trackNumber || null,
            totalTracks: r.trackCount || null,
            // Replace 100x100 with highest quality (3000x3000 is max iTunes provides)
            artworkUrl: r.artworkUrl100
                ? r.artworkUrl100.replace('100x100bb', '3000x3000bb')
                : null,
            previewUrl: r.previewUrl || null,
            explicit: r.trackExplicitness === 'explicit',
        };
    } catch (err) {
        console.warn('iTunes search failed:', err.message);
        return null;
    }
}

// 5. Deezer — another free source for art + metadata
async function searchDeezer(artist, title) {
    try {
        const q = encodeURIComponent(`artist:"${artist}" track:"${title}"`);
        const url = `https://api.deezer.com/search?q=${q}&limit=5`;
        const { body } = await fetchJSON(url);
        if (!body?.data?.length) return null;

        const r = body.data[0];
        const album = r.album;
        return {
            album: album?.title || null,
            artist: r.artist?.name || null,
            title: r.title || null,
            // Deezer provides xl cover art (1000x1000)
            artworkUrl: album?.cover_xl || album?.cover_big || null,
            explicit: r.explicit_lyrics || false,
            deezerUrl: r.link || null,
        };
    } catch (err) {
        console.warn('Deezer search failed:', err.message);
        return null;
    }
}

// Merge metadata from all sources, prioritizing quality
function mergeMetadata(ytInfo, mb, itunes, deezer, parsedArtist, parsedTitle) {
    const metadata = {
        // Core
        title: mb?.title || itunes?.title || deezer?.title || parsedTitle,
        artist: mb?.artist || itunes?.artist || deezer?.artist || parsedArtist,
        album: mb?.album || itunes?.album || deezer?.album || null,
        // Dates & track info
        releaseDate: mb?.date || itunes?.releaseDate || null,
        trackNumber: mb?.trackNumber || itunes?.trackNumber || null,
        totalTracks: mb?.totalTracks || itunes?.totalTracks || null,
        // Genre (MusicBrainz rarely has genre; iTunes/Deezer are better)
        genre: itunes?.genre || null,
        // Flags
        explicit: itunes?.explicit || deezer?.explicit || false,
        // IDs
        musicBrainzId: mb?.mbid || null,
        releaseGroupType: mb?.releaseGroupType || null,
        // Links
        itunesPreview: itunes?.previewUrl || null,
        deezerUrl: deezer?.deezerUrl || null,
        // YouTube fallback info
        duration: ytInfo?.duration || null,
        youtubeThumbnail: ytInfo?.thumbnail || null,
    };

    return metadata;
}

// Main: resolve best album art URL from all sources
async function resolveBestArtwork(mb, itunes, deezer, ytInfo) {
    const candidates = [
        // Cover Art Archive is lossless/highest quality
        mb ? () => getCoverArtArchive(mb.releaseId, mb.releaseGroupId) : null,
        // iTunes up to 3000x3000
        itunes?.artworkUrl ? async () => itunes.artworkUrl : null,
        // Deezer 1000x1000
        deezer?.artworkUrl ? async () => deezer.artworkUrl : null,
        // YouTube thumbnail as last resort
        ytInfo?.thumbnail ? async () => ytInfo.thumbnail : null,
    ].filter(Boolean);

    for (const fn of candidates) {
        try {
            const url = await fn();
            if (url) {
                const ok = await checkImageUrl(url);
                if (ok) return url;
            }
        } catch {
            // try next
        }
    }
    return ytInfo?.thumbnail || null;
}


// ─── ENDPOINTS ──────────────────────────────────────────────────────────────

app.get('/info', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'Missing url param' });

    try {
        const info = await ytDlp(url, {
            dumpSingleJson: true,
            noWarnings: true,
            noCallHome: true,
        });

        res.json({
            title: info.title,
            thumbnail: info.thumbnail,
            duration: info.duration,
            uploader: info.uploader,
        });
    } catch (err) {
        console.error('Info error:', err.message);
        res.status(500).json({ error: 'Could not fetch video info. Check the URL.' });
    }
});


// NEW: Rich metadata endpoint for songs
app.get('/metadata', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'Missing url param' });

    try {
        // Step 1: Get basic info from yt-dlp
        console.log('[metadata] Fetching yt-dlp info...');
        const ytInfo = await ytDlp(url, {
            dumpSingleJson: true,
            noWarnings: true,
            noCallHome: true,
        });

        const isSong =
            ytInfo.categories?.includes('Music') ||
            !!ytInfo.track ||
            !!ytInfo.artist;

        // If yt-dlp already has embedded music metadata, use it as a head start
        const ytArtist = ytInfo.artist || ytInfo.uploader || '';
        const ytTrack = ytInfo.track || ytInfo.title || '';

        const { artist: parsedArtist, title: parsedTitle } = parseArtistTitle(ytTrack, ytArtist);
        const cleanedTitle = cleanTitle(parsedTitle);

        console.log(`[metadata] Parsed: artist="${parsedArtist}" title="${cleanedTitle}"`);

        let mb = null, itunes = null, deezer = null, artistExtra = null;

        if (isSong) {
            // Step 2: Fetch from all sources in parallel
            console.log('[metadata] Querying MusicBrainz, iTunes, Deezer in parallel...');
            [mb, itunes, deezer] = await Promise.all([
                searchMusicBrainz(parsedArtist, cleanedTitle),
                searchItunes(parsedArtist, cleanedTitle),
                searchDeezer(parsedArtist, cleanedTitle),
            ]);

            // Step 3: Extra artist info from MusicBrainz
            if (mb?.artistMbid) {
                artistExtra = await getMusicBrainzArtist(mb.artistMbid);
            }
        }

        // Step 4: Resolve best artwork
        console.log('[metadata] Resolving best artwork...');
        const artworkUrl = await resolveBestArtwork(mb, itunes, deezer, ytInfo);

        // Step 5: Merge everything
        const metadata = mergeMetadata(ytInfo, mb, itunes, deezer, parsedArtist, cleanedTitle);
        if (artistExtra) {
            metadata.artistCountry = artistExtra.country;
            metadata.artistType = artistExtra.type;
        }

        res.json({
            isSong,
            artworkUrl,         // Best available 1:1 album art URL
            artworkSource:
                artworkUrl && artworkUrl.includes('coverartarchive') ? 'Cover Art Archive' :
                    artworkUrl && artworkUrl.includes('mzstatic') ? 'iTunes' :
                        artworkUrl && artworkUrl.includes('deezer') ? 'Deezer' :
                            artworkUrl && artworkUrl.includes('ytimg') ? 'YouTube' : 'Unknown',
            metadata,
            // Raw sources for debugging / additional use
            sources: {
                youtubeDlp: {
                    title: ytInfo.title,
                    thumbnail: ytInfo.thumbnail,
                    uploader: ytInfo.uploader,
                    duration: ytInfo.duration,
                    track: ytInfo.track || null,
                    artist: ytInfo.artist || null,
                },
                musicBrainz: mb,
                itunes: itunes ? { ...itunes, artworkUrl: '[resolved above]' } : null,
                deezer: deezer ? { ...deezer, artworkUrl: '[resolved above]' } : null,
            },
        });

    } catch (err) {
        console.error('Metadata error:', err.message);
        res.status(500).json({ error: 'Could not fetch metadata: ' + err.message });
    }
});


// Download album art to a temp file, returns path or null
async function downloadArtwork(artworkUrl) {
    if (!artworkUrl) return null;
    return new Promise((resolve) => {
        try {
            const artFile = path.join(os.tmpdir(), `yt-art-${Date.now()}.jpg`);
            const parsed = new URL(artworkUrl);
            const lib = parsed.protocol === 'https:' ? https : http;
            const file = fs.createWriteStream(artFile);
            const req = lib.get({ hostname: parsed.hostname, path: parsed.pathname + parsed.search }, (r) => {
                if (r.statusCode !== 200) { file.close(); resolve(null); return; }
                r.pipe(file);
                file.on('finish', () => { file.close(); resolve(artFile); });
            });
            req.on('error', () => { file.close(); resolve(null); });
            req.setTimeout(10000, () => { req.destroy(); resolve(null); });
        } catch {
            resolve(null);
        }
    });
}

// Embed ID3 tags + cover art into an MP3 using ffmpeg
// Returns path to the tagged file (may be a new tmp file)
function embedMp3Tags(mp3Path, metadata, artworkPath) {
    return new Promise((resolve, reject) => {
        const { execFile } = require('child_process');
        const taggedFile = mp3Path.replace(/\.mp3$/, '') + '-tagged.mp3';

        const ffmpegArgs = ['-y', '-i', mp3Path];

        if (artworkPath) {
            ffmpegArgs.push('-i', artworkPath);
        }

        // Map audio stream
        ffmpegArgs.push('-map', '0:a');

        // Map cover art if provided
        if (artworkPath) {
            ffmpegArgs.push('-map', '1:v');
            ffmpegArgs.push('-c:v', 'mjpeg');
            ffmpegArgs.push('-metadata:s:v', 'title=Album cover');
            ffmpegArgs.push('-metadata:s:v', 'comment=Cover (front)');
        }

        ffmpegArgs.push('-c:a', 'copy', '-id3v2_version', '3');

        // Write ID3 tags
        const tags = {
            title: metadata.title,
            artist: metadata.artist,
            album: metadata.album,
            date: metadata.releaseDate ? metadata.releaseDate.slice(0, 4) : null,
            track: metadata.trackNumber && metadata.totalTracks
                ? `${metadata.trackNumber}/${metadata.totalTracks}`
                : metadata.trackNumber,
            genre: metadata.genre,
            comment: metadata.musicBrainzId ? `MusicBrainz: ${metadata.musicBrainzId}` : null,
        };

        for (const [key, val] of Object.entries(tags)) {
            if (val) ffmpegArgs.push('-metadata', `${key}=${val}`);
        }

        ffmpegArgs.push(taggedFile);

        console.log('[ffmpeg] Embedding tags into', mp3Path);
        execFile('ffmpeg', ffmpegArgs, (err, stdout, stderr) => {
            if (err) {
                console.warn('[ffmpeg] Tag embedding failed:', err.message);
                resolve(mp3Path); // fall back to untagged file
            } else {
                console.log('[ffmpeg] Tags embedded successfully →', taggedFile);
                fs.unlink(mp3Path, () => { }); // clean up untagged version
                resolve(taggedFile);
            }
        });
    });
}

app.get('/download', async (req, res) => {
    const { url, format } = req.query;
    if (!url) return res.status(400).json({ error: 'Missing url' });

    const isAudio = format === 'mp3';

    let ytInfo = null;
    let title = 'download';
    try {
        ytInfo = await ytDlp(url, { dumpSingleJson: true, noWarnings: true, noCallHome: true });
        title = sanitizeFilename(ytInfo.title);
    } catch (_) { }

    const filename = `${title}.${isAudio ? 'mp3' : 'mp4'}`;
    const tmpFile = path.join(os.tmpdir(), `yt-dl-${Date.now()}.${isAudio ? 'mp3' : 'mp4'}`);

    try {
        const ytDlpArgs = isAudio
            ? {
                output: tmpFile,
                extractAudio: true,
                audioFormat: 'mp3',
                audioQuality: 0,
                noWarnings: true,
                noCallHome: true,
            }
            : {
                output: tmpFile,
                format: 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
                mergeOutputFormat: 'mp4',
                noWarnings: true,
                noCallHome: true,
            };

        console.log('[download] Starting yt-dlp —', isAudio ? 'MP3' : 'MP4');
        await ytDlp(url, ytDlpArgs);

        let finalFile = tmpFile;

        if (!fs.existsSync(finalFile)) {
            const files = fs.readdirSync(path.dirname(tmpFile));
            const match = files.find(f => f.startsWith(path.basename(tmpFile)));
            if (match) {
                finalFile = path.join(path.dirname(tmpFile), match);
            }
        }

        if (!fs.existsSync(finalFile)) {
            throw new Error("yt-dlp output file not found");
        }

        // ── MP3 + song: enrich with metadata & cover art ──
        if (isAudio && ytInfo) {
            const isSong =
                ytInfo.categories?.includes('Music') ||
                !!ytInfo.track ||
                !!ytInfo.artist;

            if (isSong) {
                console.log('[download] Song detected — fetching metadata for tag embedding');
                try {
                    const { artist: parsedArtist, title: parsedTitle } = parseArtistTitle(
                        ytInfo.track || ytInfo.title || '',
                        ytInfo.artist || ytInfo.uploader || ''
                    );
                    const cleanedTitle = cleanTitle(parsedTitle);

                    const [mb, itunes, deezer] = await Promise.all([
                        searchMusicBrainz(parsedArtist, cleanedTitle),
                        searchItunes(parsedArtist, cleanedTitle),
                        searchDeezer(parsedArtist, cleanedTitle),
                    ]);

                    const metadata = mergeMetadata(ytInfo, mb, itunes, deezer, parsedArtist, cleanedTitle);
                    const artworkUrl = await resolveBestArtwork(mb, itunes, deezer, ytInfo);

                    console.log('[download] Artwork URL:', artworkUrl);
                    const artworkPath = await downloadArtwork(artworkUrl);
                    console.log('[download] Artwork downloaded to:', artworkPath);

                    finalFile = await embedMp3Tags(finalFile, metadata, artworkPath);

                    if (artworkPath) fs.unlink(artworkPath, () => { });
                } catch (metaErr) {
                    console.warn('[download] Metadata enrichment failed (non-fatal):', metaErr.message);
                    // Continue with untagged file
                }
            } else {
                console.log('[download] Not a song — skipping tag embedding');
            }
        }

        const stat = fs.statSync(finalFile);
        console.log('[download] Serving file:', finalFile, '|', stat.size, 'bytes');

        res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/"/g, '\\"')}"`);
        res.setHeader('Content-Type', isAudio ? 'audio/mpeg' : 'video/mp4');
        res.setHeader('Content-Length', stat.size);

        const stream = fs.createReadStream(finalFile);
        stream.pipe(res);
        stream.on('close', () => {
            fs.unlink(finalFile, () => { });
        });

    } catch (err) {
        console.error('[download] Error:', err.message);
        if (!res.headersSent) res.status(500).json({ error: 'Download failed: ' + err.message });
    }
});


// Fetch playlist metadata (title + track list) without downloading
app.get('/playlist-info', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'Missing url param' });

    try {
        console.log('[playlist-info] Fetching playlist info for:', url);
        const info = await ytDlp(url, {
            dumpSingleJson: true,
            flatPlaylist: true,
            noWarnings: true,
        });

        if (!info.entries) {
            return res.status(400).json({ error: 'URL does not appear to be a playlist.' });
        }

        console.log(`[playlist-info] Found ${info.entries.length} tracks in "${info.title}"`);

        res.json({
            title: info.title,
            uploader: info.uploader || info.channel || null,
            thumbnail: info.thumbnails?.[info.thumbnails.length - 1]?.url || null,
            count: info.entries.length,
            tracks: info.entries.map((e, i) => ({
                index: i + 1,
                id: e.id,
                title: e.title,
                duration: e.duration || null,
                url: e.url || `https://www.youtube.com/watch?v=${e.id}`,
            })),
        });
    } catch (err) {
        console.error('[playlist-info] Error:', err.message);
        res.status(500).json({ error: 'Could not fetch playlist info: ' + err.message });
    }
});

async function runParallel(tasks, limit = 4) {
    const results = [];
    let i = 0;

    async function worker() {
        while (i < tasks.length) {
            const currentIndex = i++;
            try {
                results[currentIndex] = await tasks[currentIndex]();
            } catch (e) {
                results[currentIndex] = null;
            }
        }
    }

    const workers = Array.from({ length: limit }, () => worker());
    await Promise.all(workers);

    return results;
}
// Download a full playlist as a ZIP of tagged MP3s
// Streams progress events via Server-Sent Events, then sends the ZIP
app.get('/download-playlist', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'Missing url param' });

    // Use SSE so the frontend can show per-track progress
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

    const tmpDir = path.join(os.tmpdir(), `yt-playlist-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    const cleanupFiles = [];

    try {
        // Step 1: Get track list
        send({ type: 'status', message: 'Fetching playlist info...' });
        console.log('[playlist-dl] Fetching playlist info:', url);

        const info = await ytDlp(url, {
            dumpSingleJson: true,
            flatPlaylist: true,
            noWarnings: true,
            noCallHome: true,
        });

        if (!info.entries?.length) {
            send({ type: 'error', message: 'No tracks found in playlist.' });
            return res.end();
        }

        const playlistTitle = sanitizeFilename(info.title || 'playlist');
        const total = info.entries.length;
        send({ type: 'playlist', title: info.title, total });
        console.log(`[playlist-dl] "${playlistTitle}" — ${total} tracks`);

        // Step 2: Download & tag each track sequentially
        const CONCURRENCY = 6; // tweak this (4–8 is usually optimal)

        const tasks = info.entries.map((entry, i) => async () => {
            const trackNum = i + 1;
            const trackUrl = entry.url || `https://www.youtube.com/watch?v=${entry.id}`;

            send({ type: 'track-start', index: trackNum, total, title: entry.title });
            console.log(`[playlist-dl] [${trackNum}/${total}] Downloading: ${entry.title}`);

            const tmpMp3 = path.join(tmpDir, `track-${trackNum}-${Date.now()}.mp3`);
            cleanupFiles.push(tmpMp3);

            try {
                await ytDlp(trackUrl, {
                    output: tmpMp3,
                    extractAudio: true,
                    audioFormat: 'mp3',
                    audioQuality: 0,
                    noWarnings: true,
                    noCallHome: true,
                });

                let finalMp3 = tmpMp3;
                if (!fs.existsSync(finalMp3)) {
                    const alt = tmpMp3 + '.mp3';
                    if (fs.existsSync(alt)) {
                        finalMp3 = alt;
                        cleanupFiles.push(alt);
                    }
                }

                let ytTrackInfo = null;
                try {
                    ytTrackInfo = await ytDlp(trackUrl, {
                        dumpSingleJson: true,
                        noWarnings: true,
                        noCallHome: true,
                    });
                } catch { }

                const { artist: parsedArtist, title: parsedTitle } = parseArtistTitle(
                    ytTrackInfo?.track || ytTrackInfo?.title || entry.title,
                    ytTrackInfo?.artist || ytTrackInfo?.uploader || ''
                );
                const cleanedTitle = cleanTitle(parsedTitle);

                const [mb, itunes, deezer] = await Promise.all([
                    searchMusicBrainz(parsedArtist, cleanedTitle),
                    searchItunes(parsedArtist, cleanedTitle),
                    searchDeezer(parsedArtist, cleanedTitle),
                ]);

                const metadata = mergeMetadata(
                    ytTrackInfo,
                    mb,
                    itunes,
                    deezer,
                    parsedArtist,
                    cleanedTitle
                );

                if (!metadata.trackNumber) metadata.trackNumber = trackNum;
                if (!metadata.totalTracks) metadata.totalTracks = total;

                const artworkUrl = await resolveBestArtwork(mb, itunes, deezer, ytTrackInfo);
                const artworkPath = await downloadArtwork(artworkUrl);
                if (artworkPath) cleanupFiles.push(artworkPath);

                finalMp3 = await embedMp3Tags(finalMp3, metadata, artworkPath);
                cleanupFiles.push(finalMp3);

                const safeTitle = sanitizeFilename(metadata.title || entry.title);
                const zipName = `${String(trackNum).padStart(2, '0')} - ${safeTitle}.mp3`;

                send({ type: 'track-done', index: trackNum, total, name: zipName });

                return { file: finalMp3, name: zipName };

            } catch (err) {
                console.warn(`[playlist-dl] [${trackNum}] Failed: ${err.message}`);
                send({ type: 'track-error', index: trackNum, title: entry.title, error: err.message });
                return null;
            }
        });

        const results = await runParallel(tasks, CONCURRENCY);
        const mp3Files = results.filter(Boolean);

        if (!mp3Files.length) {
            send({ type: 'error', message: 'All tracks failed to download.' });
            return res.end();
        }

        // Step 3: Build ZIP and send download URL
        send({ type: 'status', message: 'Building ZIP...' });
        console.log('[playlist-dl] Building ZIP with', mp3Files.length, 'tracks');

        const zipFile = path.join(os.tmpdir(), `${playlistTitle}-${Date.now()}.zip`);
        cleanupFiles.push(zipFile);

        await new Promise((resolve, reject) => {
            const output = fs.createWriteStream(zipFile);
            const archive = archiver('zip', { zlib: { level: 6 } });
            archive.on('error', reject);
            output.on('close', resolve);
            archive.pipe(output);
            for (const { file, name } of mp3Files) {
                archive.file(file, { name: `${playlistTitle}/${name}` });
            }
            archive.finalize();
        });

        const zipStat = fs.statSync(zipFile);
        console.log('[playlist-dl] ZIP ready:', zipFile, '|', zipStat.size, 'bytes');

        // Store the zip path temporarily keyed by a token so the client can fetch it
        const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        pendingZips.set(token, { file: zipFile, name: `${playlistTitle}.zip`, expires: Date.now() + 5 * 60 * 1000 });

        send({ type: 'done', token, filename: `${playlistTitle}.zip`, trackCount: mp3Files.length });
        res.end();

    } catch (err) {
        console.error('[playlist-dl] Fatal error:', err.message);
        send({ type: 'error', message: err.message });
        res.end();
    } finally {
        // Clean up individual MP3s and artwork (not the zip — that's fetched separately)
        setTimeout(() => {
            for (const f of cleanupFiles) {
                if (f && !f.endsWith('.zip')) fs.unlink(f, () => { });
            }
            try { fs.rmdirSync(tmpDir); } catch (_) { }
        }, 5000);
    }
});

// In-memory store for ready ZIPs (token → file path)
const pendingZips = new Map();

// Serve a completed ZIP by token
app.get('/download-zip', (req, res) => {
    const { token } = req.query;
    const entry = pendingZips.get(token);

    if (!entry) return res.status(404).json({ error: 'ZIP not found or expired.' });
    if (Date.now() > entry.expires) {
        pendingZips.delete(token);
        fs.unlink(entry.file, () => { });
        return res.status(410).json({ error: 'ZIP has expired.' });
    }

    pendingZips.delete(token);
    const stat = fs.statSync(entry.file);

    res.setHeader('Content-Disposition', `attachment; filename="${entry.name.replace(/"/g, '\\"')}"`);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Length', stat.size);

    const stream = fs.createReadStream(entry.file);
    stream.pipe(res);
    stream.on('close', () => fs.unlink(entry.file, () => { }));
});


app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/favicon.ico', (req, res) => {
    res.status(218).end();
});

app.listen(PORT, '0.0.0.0', () => {
    console.log('');
    console.log('YouTube Downloader');
    console.log(`http://localhost:${PORT}`);
    console.log('');
});