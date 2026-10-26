/** What a listener used: kind of device, player or browser, and operating system. */
export interface ClientInfo {
  device: 'desktop' | 'mobile' | 'tablet' | 'speaker' | 'tv' | 'car' | 'bot' | 'other';
  player: string;
  os: string;
}

type Rule = [RegExp, string];

// Radio players and apps first (they often claim to be a browser as well), then browsers.
const players: Rule[] = [
  [/TuneIn/i, 'TuneIn'],
  [/radio\.de|radio\.net|radio\.fr|radio\.at|radio\.es|radio\.it|radio\.pt|radio\.dk|radio\.se|radio\.pl/i, 'radio.net'],
  [/Radioplayer/i, 'Radioplayer'],
  [/myTuner/i, 'myTuner'],
  [/Simple ?Radio|Streema/i, 'Simple Radio'],
  [/Radio ?Garden/i, 'Radio Garden'],
  [/iHeart/i, 'iHeartRadio'],
  [/Sonos/i, 'Sonos'],
  [/AlexaMediaPlayer|Echo|Amazon ?(?:Alexa|Music)/i, 'Amazon Alexa'],
  [/Google ?Home|CrKey|Chromecast|GoogleCast/i, 'Google Cast'],
  [/Bose/i, 'Bose'],
  [/HEOS|Denon|Marantz/i, 'HEOS'],
  [/BluOS|Bluesound/i, 'BluOS'],
  [/Roku/i, 'Roku'],
  [/Volumio/i, 'Volumio'],
  [/Kodi|XBMC/i, 'Kodi'],
  [/VLC|LibVLC/i, 'VLC'],
  [/Winamp/i, 'Winamp'],
  [/foobar2000/i, 'foobar2000'],
  [/AIMP/i, 'AIMP'],
  [/MPlayer|mpv/i, 'mpv'],
  [/Lavf|FFmpeg/i, 'FFmpeg'],
  [/GStreamer/i, 'GStreamer'],
  [/iTunes|Music\/\d|AppleCoreMedia|AppleTV|AirPlay/i, 'Apple Music/iTunes'],
  [/Windows-Media-Player|NSPlayer|WMFSDK/i, 'Windows Media Player'],
  [/ExoPlayer|stagefright|Android ?Media|okhttp/i, 'Android app'],
  [/CFNetwork/i, 'iOS app'],
  [/Edg(?:e|A|iOS)?\//, 'Edge'],
  [/OPR\/|Opera/, 'Opera'],
  [/SamsungBrowser/, 'Samsung Internet'],
  [/Firefox|FxiOS/, 'Firefox'],
  [/Chrome|CriOS|Chromium/, 'Chrome'],
  [/Safari/, 'Safari'],
];

const systems: Rule[] = [
  [/Windows/i, 'Windows'],
  [/iPhone|iPad|iPod|iOS|CFNetwork|AppleCoreMedia/i, 'iOS'],
  [/Mac OS X|Macintosh|Darwin/i, 'macOS'],
  [/Android/i, 'Android'],
  [/CrOS/i, 'ChromeOS'],
  [/Tizen/i, 'Tizen'],
  [/webOS/i, 'webOS'],
  [/Linux|X11/i, 'Linux'],
];

const bots = /bot\b|crawler|spider|slurp|monitor|uptime|pingdom|statuscake|check_http|nagios|zabbix|curl\/|wget|python-requests|python-urllib|go-http-client|java\/|httpclient|headless|facebookexternalhit|preview/i;

const first = (rules: Rule[], ua: string) => rules.find(([re]) => re.test(ua))?.[1];

export function classifyClient(userAgent: string | null | undefined): ClientInfo {
  const ua = (userAgent ?? '').slice(0, 500);
  if (!ua) return { device: 'other', player: 'Unknown', os: 'Unknown' };
  if (bots.test(ua)) return { device: 'bot', player: ua.split(/[/ ;(]/)[0]!.slice(0, 40) || 'Bot', os: 'Unknown' };
  const player = first(players, ua) ?? (ua.split(/[/ ;(]/)[0]!.slice(0, 40) || 'Unknown');
  const os = first(systems, ua) ?? 'Unknown';
  let device: ClientInfo['device'] = 'other';
  if (/Sonos|Alexa|Echo|Google ?Home|Bose|HEOS|BluOS|Volumio|Denon|Marantz/i.test(ua)) device = 'speaker';
  else if (/SmartTV|Smart-TV|AppleTV|Roku|CrKey|Chromecast|Tizen|webOS|BRAVIA|AFT[A-Z]/i.test(ua)) device = 'tv';
  else if (/CarPlay|Android ?Auto|Automotive/i.test(ua)) device = 'car';
  else if (/iPad|Tablet|Kindle|Silk/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua) && /Mozilla/.test(ua))) device = 'tablet';
  else if (/Mobile|iPhone|iPod|Android|Windows Phone|ExoPlayer|CFNetwork|stagefright|okhttp/i.test(ua)) device = 'mobile';
  else if (/Windows|Macintosh|Mac OS X|X11|Linux|CrOS|VLC|Winamp|foobar|AIMP|iTunes/i.test(ua)) device = 'desktop';
  return { device, player, os };
}
