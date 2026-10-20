import * as cheerio from 'cheerio';

const num = (s) => Number(String(s).replace(/[^\d]/g, '')) || 0;

export async function fetchHtml() {
  const url = process.env.SOURCE_URL || 'https://ninjazenshin.online/?panel=clan-ranking';
  const res = await fetch(url, { headers: { 'user-agent': 'clan-tracker/1.0' }, cache: 'no-store' });
  if (!res.ok) throw new Error(`Source returned ${res.status}`);
  return res.text();
}

// Classifies each table by its header cells; season tables take the season from the preceding heading.
export function parse(html) {
  const $ = cheerio.load(html);
  const clans = [];
  const wars = [];
  let season = null;
  let ended = null;
  $('h1,h2,h3,table').each((_, el) => {
    if (el.tagName !== 'table') {
      const m = $(el).text().match(/Season\s+(\d+)/i);
      if (m) {
        season = Number(m[1]);
        const e = $(el).nextAll().slice(0, 2).text().match(/Ended\s+(\d{1,2}\s+\w+\s+\d{4})/i);
        ended = e ? new Date(e[1] + ' UTC').toISOString().slice(0, 10) : null;
      }
      return;
    }
    const heads = $(el).find('th').map((_, th) => $(th).text().trim().toLowerCase()).get();
    const rows = $(el).find('tbody tr').length ? $(el).find('tbody tr') : $(el).find('tr').slice(1);
    if (heads.includes('master')) {
      rows.each((_, tr) => {
        const c = $(tr).find('td').map((_, td) => $(td).text().trim()).get();
        const [cur, max] = (c[3] || '').split('/');
        if (c.length >= 5) clans.push({ rank: num(c[0]), name: c[1], master: c[2], members: num(cur), max_members: num(max), reputation: num(c[4]) });
      });
    } else if (heads.includes('reputation') && season !== null) {
      rows.each((_, tr) => {
        const c = $(tr).find('td').map((_, td) => $(td).text().trim()).get();
        if (c.length >= 4) wars.push({ season, rank: num(c[0]), clan_name: c[1], members: num(c[2]), reputation: num(c[3]), ended_on: ended });
      });
    }
  });
  return { clans, wars, closed: /season closed/i.test($.text()) };
}
