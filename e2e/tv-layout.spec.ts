import { test, expect, enterTab, routePlaylist } from './helpers';

test('Live shows the focused or hovered channel guide without tuning', async ({ page }, testInfo) => {
  await page.clock.setFixedTime(new Date('2026-09-15T12:00:00Z'));
  await routePlaylist(page, [
    '#EXTM3U',
    '#EXTINF:-1 tvg-id="one" group-title="News",Channel One',
    'http://host/one.m3u8',
    '#EXTINF:-1 tvg-id="two" group-title="News",Channel Two',
    'http://host/two.m3u8',
    '#EXTINF:-1 tvg-id="three" group-title="News",Channel Three',
    'http://host/three.m3u8',
  ].join('\n'));
  await page.route('http://host/guide.xml', route => route.fulfill({
    contentType: 'application/xml',
    body: `<tv>${['one', 'two'].map(id => `
      <channel id="${id}"><display-name>${id}</display-name></channel>
      <programme channel="${id}" start="20260915110000 +0000" stop="20260915130000 +0000">
        <title>Now on ${id}</title>
      </programme>
      <programme channel="${id}" start="20260915130000 +0000" stop="20260915140000 +0000">
        <title>Next on ${id}</title>
      </programme>`).join('')}</tv>`,
  }));
  await page.addInitScript(() => {
    localStorage.setItem('iptv_playlists', JSON.stringify([
      { id: 'p1', name: 'Test', url: 'http://host/playlist.m3u' },
    ]));
    localStorage.setItem('iptv_epg_url', JSON.stringify('http://host/guide.xml'));
    localStorage.setItem('iptv_live_preview', JSON.stringify(false));
  });
  const streams: string[] = [];
  page.on('request', request => {
    if (request.url().endsWith('.m3u8')) streams.push(request.url());
  });
  await page.goto('/');
  const live = page.locator('#view-channels');
  const rows = live.locator('.channel-item');
  const panel = live.locator('#live-preview');
  await expect(page.locator('.tab-bar-item[data-section="epg"]')).toHaveCount(0);
  await expect(panel.locator('.live-preview-title')).toHaveText('Now on one');
  await page.keyboard.press('ArrowDown');
  await expect(panel.locator('.live-preview-title')).toHaveText('Now on two');
  await expect(panel.locator('.live-preview-upcoming')).toContainText('Next on two');
  const first = (await rows.first().boundingBox())!;
  await page.mouse.move(first.x + 20, first.y + 20);
  await page.mouse.move(first.x + 25, first.y + 25);
  await expect(panel.locator('.live-preview-title')).toHaveText('Now on one');
  await expect(rows.first()).toHaveClass(/focused/);
  await expect(rows.nth(1)).not.toHaveClass(/focused/);
  await page.screenshot({ path: testInfo.outputPath('live-guide.png') });
  await page.evaluate(() => document.dispatchEvent(
    new CustomEvent('cursorStateChange', { detail: { visibility: false } })));
  await expect(panel.locator('.live-preview-title')).toHaveText('Now on two');
  await rows.nth(2).hover();
  await expect(panel).toContainText('No program information available.');
  await expect(panel.locator('.live-preview-slot')).toHaveCount(0);
  expect(streams).toEqual([]);
});

for (const section of ['movies', 'series'] as const) {
  test(`${section} starts on All and supports sidebar filters by remote and pointer`, async ({ page }, testInfo) => {
    await page.route('**/get.php*', route => route.fulfill({
      contentType: 'application/x-mpegurl',
      body: '#EXTM3U\n#EXTINF:-1,Channel One\nhttp://host/one.m3u8',
    }));
    await page.route('**/xmltv.php*', route => route.fulfill({ body: '<tv></tv>' }));
    await page.route('**/player_api.php*', route => {
      const params = new URL(route.request().url()).searchParams;
      const action = params.get('action');
      const category = params.get('category_id');
      if (action === 'get_vod_categories' || action === 'get_series_categories') {
        return route.fulfill({ json: [
          { category_id: '1', category_name: 'Action' },
          { category_id: '2', category_name: 'Drama' },
        ] });
      }
      if (action === 'get_vod_streams' || action === 'get_series') {
        return route.fulfill({ json: ['1', '2'].filter(id => !category || category === id).map(id => ({
          stream_id: id, series_id: id, category_id: id,
          name: id === '1' ? 'Action title' : 'Drama title',
          container_extension: 'mp4',
        })) });
      }
      return route.fulfill({ json: {} });
    });
    await page.addInitScript(() => {
      localStorage.setItem('iptv_playlists', JSON.stringify([{
        id: 'x1', name: 'Test', url: 'http://host', source: 'xtream',
        xtream: { username: 'u', password: 'p' },
      }]));
    });
    await page.goto('/');
    await enterTab(page, section);
    const view = page.locator(`#view-${section}`);
    const sidebar = view.locator('.catalog-sidebar');
    const titles = view.locator('.catalog-grid .catalog-tile-name');
    await expect(sidebar.locator('[aria-current="true"]')).toHaveText('All');
    await expect(titles).toHaveText(['Action title', 'Drama title']);
    await page.screenshot({ path: testInfo.outputPath(`${section}-all.png`) });
    await sidebar.getByRole('button', { name: 'Drama', exact: true }).click();
    await expect(titles).toHaveText(['Drama title']);
    await expect(sidebar.locator('[aria-current="true"]')).toHaveText('Drama');
    await page.keyboard.press('ArrowRight');
    await expect(view.locator('.catalog-grid .catalog-tile.focused')).toContainText('Drama title');
    await page.keyboard.press('ArrowLeft');
    await expect(sidebar.locator('.focused')).toHaveText('Drama');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Enter');
    await expect(sidebar.locator('[aria-current="true"]')).toHaveText('Action');
    await expect(titles).toHaveText(['Action title']);
    await page.keyboard.press('Escape');
    await expect(sidebar.locator('[aria-current="true"]')).toHaveText('All');
    await expect(titles).toHaveText(['Action title', 'Drama title']);
    await sidebar.getByRole('button', { name: 'Watchlist', exact: true }).click();
    await expect(view.locator('.catalog-grid')).toContainText('Your Watchlist is empty.');
    await page.keyboard.press('ArrowRight');
    await expect(sidebar.locator('.focused')).toHaveText('Watchlist');
  });
}
