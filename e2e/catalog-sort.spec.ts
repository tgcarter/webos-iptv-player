import { test, expect, enterTab, type Page } from './helpers';
import { THEMES } from '../src/config/themes';

async function seedCatalog(page: Page): Promise<void> {
  await page.route('**/get.php*', route => route.fulfill({
    contentType: 'application/x-mpegurl',
    body: '#EXTM3U\n#EXTINF:-1,Channel 1\nhttp://host/a\n',
  }));
  await page.route('**/xmltv.php*', route => route.fulfill({
    contentType: 'application/xml', body: '<tv></tv>',
  }));
  await page.route('**/player_api.php*', route => {
    const url = new URL(route.request().url());
    const action = url.searchParams.get('action');
    let body: unknown = {};
    if (action === 'get_vod_categories' || action === 'get_series_categories') {
      body = Array.from({ length: 8 }, (_, i) => ({
        category_id: String(i + 1), category_name: `Category ${i + 1}`,
      }));
    } else if (action === 'get_vod_streams' || action === 'get_series') {
      body = Array.from({ length: 50 }, (_, i) => {
        const n = 50 - i;
        return {
          stream_id: 100 + i, series_id: 200 + i, name: `Title ${n}`,
          stream_icon: '', cover: '', container_extension: 'mp4',
          category_id: url.searchParams.get('category_id') ?? '1',
          added: String(1_700_000_000 + n),
          rating: n === 13 ? '' : String(n % 10),
          year: n === 17 ? '' : String(2000 + n),
        };
      });
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.addInitScript(() => {
    if (!localStorage.getItem('iptv_playlists')) {
      localStorage.setItem('iptv_playlists', JSON.stringify([{
        id: 'x1', name: 'Account 1', url: 'http://host', source: 'xtream',
        xtream: { username: 'u', password: 'p' },
      }]));
    }
  });
}

const grid = (page: Page, section = 'movies') =>
  page.locator(`#view-${section} .catalog-layer-grid`);
const tiles = (page: Page, section = 'movies') =>
  grid(page, section).locator('.catalog-tile-name');

test.beforeEach(async ({ page }) => {
  await seedCatalog(page);
});

for (const section of ['movies', 'series'] as const) {
  test(`${section}: sorting applies to All and leaves saved titles in their own order`, async ({ page }) => {
    await page.addInitScript((kind) => {
      const resume: Record<string, unknown> = {};
      const watchlist: Record<string, unknown> = {};
      for (let i = 0; i < 2; i++) {
        const itemId = String(100 + i);
        const entry = { accountId: 'x1', itemId, name: `Saved ${i ? 1 : 9}`, poster: '', categoryId: '1' };
        const resumeKind = kind === 'movies' ? 'vod' : 'episode';
        const watchKind = kind === 'movies' ? 'vod' : 'series';
        resume[`x1|${resumeKind}|${itemId}`] = {
          ...entry, kind: resumeKind, ext: 'mp4', position: 100, duration: 600, updatedAt: 2 - i,
        };
        watchlist[`x1|${watchKind}|${itemId}`] = {
          ...entry, kind: watchKind, rating: '', containerExtension: 'mp4', addedAt: 2 - i,
        };
      }
      localStorage.setItem('iptv_resume', JSON.stringify(resume));
      localStorage.setItem('iptv_watchlist', JSON.stringify(watchlist));
    }, section);
    await page.goto('/');
    await enterTab(page, section);
    const layer = grid(page, section);
    await expect(tiles(page, section).first()).toHaveText('Title 50');
    const trigger = layer.locator('.catalog-sort .dropdown-trigger');
    await trigger.click();
    await layer.locator('[data-dropdown-value="name"]').click();
    await expect(tiles(page, section).first()).toHaveText('Title 1');
    await trigger.hover();
    await expect(trigger).toHaveClass(/focused/);
    await page.keyboard.press('ArrowDown');
    await expect(layer.locator('.catalog-tile.focused')).toHaveCount(1);
    await page.keyboard.press('ArrowUp');
    await expect(layer.locator('.catalog-sort .focused')).toHaveCount(1);
    for (const list of ['continue', 'watchlist']) {
      await layer.locator(`[data-collection-see-all="${list}"]`).click();
      await expect(tiles(page, section)).toHaveText(['Saved 9', 'Saved 1']);
    }
  });
}

test('sorts the full catalog, uses explicit radio directions, and restores server order', async ({ page }) => {
  const details: string[] = [];
  page.on('request', request => {
    if (/action=get_(?:vod|series)_info/.test(request.url())) details.push(request.url());
  });
  await page.goto('/');
  await enterTab(page, 'movies');
  const layer = grid(page);
  await expect(tiles(page).first()).toHaveText('Title 50');
  await expect(layer.getByRole('radio')).toHaveCount(0);
  await layer.locator('.dropdown-trigger').click();
  await layer.locator('[data-dropdown-value="name"]').click();
  await expect(tiles(page).nth(12)).toHaveText('Title 13');
  await expect(layer.getByRole('radio')).toHaveText(['A–Z', 'Z–A']);
  const asc = layer.getByRole('radio', { name: 'A–Z', exact: true });
  const desc = layer.getByRole('radio', { name: 'Z–A', exact: true });
  await expect(asc).toHaveAttribute('aria-checked', 'true');
  await desc.hover();
  await expect(desc).toHaveClass(/focused/);
  await expect(asc).toHaveClass(/active/);
  await expect(desc).not.toHaveClass(/active/);
  await desc.click();
  await expect(desc).toHaveAttribute('aria-checked', 'true');
  await expect(tiles(page).first()).toHaveText('Title 50');
  await layer.locator('.dropdown-trigger').click();
  await layer.locator('[data-dropdown-value="name"]').click();
  await expect(desc).toHaveAttribute('aria-checked', 'true');
  for (const [by, first, labels] of [
    ['added', 'Title 50', ['Newest', 'Oldest']],
    ['rating', 'Title 49', ['Highest', 'Lowest']],
    ['year', 'Title 50', ['Newest', 'Oldest']],
  ] as const) {
    await layer.locator('.dropdown-trigger').click();
    await layer.locator(`[data-dropdown-value="${by}"]`).click();
    await expect(layer.getByRole('radio')).toHaveText([...labels]);
    await expect(layer.getByRole('radiogroup')).toHaveAttribute('aria-label', `${labels[0]} / ${labels[1]}`);
    await expect(layer.getByRole('radio', { name: labels[0] })).toHaveAttribute('aria-checked', 'true');
    await expect(tiles(page).first()).toHaveText(first);
  }
  const oldest = layer.getByRole('radio', { name: 'Oldest' });
  await oldest.click();
  await expect(oldest).toHaveAttribute('aria-checked', 'true');
  await expect(tiles(page).first()).toHaveText('Title 1');
  await layer.locator('.dropdown-trigger').click();
  await layer.locator('[data-dropdown-value="default"]').click();
  await expect(layer.getByRole('radio')).toHaveCount(0);
  await expect(tiles(page).first()).toHaveText('Title 50');
  expect(details).toEqual([]);
});

test('traps only the open menu, restores the trigger, and navigates both radios by remote', async ({ page }) => {
  await page.goto('/');
  await enterTab(page, 'movies');
  const layer = grid(page);
  const trigger = layer.locator('.dropdown-trigger');
  await trigger.hover();
  await page.keyboard.press('Enter');
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  const first = layer.locator('[data-dropdown-value="default"]');
  await expect(first).toHaveClass(/focused/);
  await page.keyboard.press('ArrowUp');
  await expect(first).toHaveClass(/focused/);
  for (let i = 0; i < 7; i++) await page.keyboard.press('ArrowDown');
  await expect(layer.locator('[data-dropdown-value="year"]')).toHaveClass(/focused/);
  await page.keyboard.press('ArrowDown');
  await expect(layer.locator('[data-dropdown-value="year"]')).toHaveClass(/focused/);
  await page.keyboard.press('Escape');
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await expect(trigger).toHaveClass(/focused/);
  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(trigger).toHaveClass(/focused/);
  await page.keyboard.press('ArrowRight');
  await expect(layer.locator('[data-sort-direction="asc"]')).toHaveClass(/focused/);
  await page.keyboard.press('ArrowRight');
  const desc = layer.locator('[data-sort-direction="desc"]');
  await expect(desc).toHaveClass(/focused/);
  await page.keyboard.press('ArrowRight');
  await expect(desc).toHaveClass(/focused/);
  await page.keyboard.press('Enter');
  await expect(desc).toHaveAttribute('aria-checked', 'true');
  await expect(desc).toHaveClass(/focused/);
  await page.keyboard.press('ArrowDown');
  await expect(layer.locator('.catalog-tile.focused')).toHaveCount(1);
  await page.keyboard.press('ArrowUp');
  await expect(layer.locator('.catalog-sort .focused')).toHaveCount(1);
  await trigger.click();
  await page.keyboard.press('ArrowLeft');
  await expect(trigger).toHaveClass(/focused/);
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await trigger.click();
  await layer.locator('.catalog-grid-title').click();
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
});

test('keeps virtual grids and newly loaded categories sorted, independently for each section', async ({ page }) => {
  await page.goto('/');
  await enterTab(page, 'movies');
  const layer = grid(page);
  await layer.locator('.dropdown-trigger').click();
  await layer.locator('[data-dropdown-value="name"]').click();
  await layer.locator('[data-category-id="7"].catalog-cat').click();
  const full = grid(page);
  await expect(full.locator('.catalog-grid-title')).toHaveText('Category 7');
  await expect(full.locator('.catalog-tile-name').first()).toHaveText('Title 1');
  await full.locator('.catalog-tile').first().hover();
  for (let i = 0; i < 9; i++) await page.keyboard.press('ArrowDown');
  await expect(full.locator('.catalog-tile.focused .catalog-tile-name')).toHaveText('Title 46');
  await page.keyboard.press('ArrowDown');
  await expect(full.locator('.catalog-tile.focused .catalog-tile-name')).toHaveText('Title 46');
  for (let i = 0; i < 9; i++) await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await expect(full.locator('.catalog-sort .focused')).toHaveCount(1);
  await full.getByRole('radio', { name: 'Z–A' }).click();
  await expect(full.locator('.catalog-tile-name').first()).toHaveText('Title 50');
  await expect(full.getByRole('radio', { name: 'Z–A' })).toHaveClass(/focused/);
  await page.keyboard.press('Escape');
  await expect(layer).toBeVisible();
  await expect(layer.getByRole('radio', { name: 'Z–A' })).toHaveAttribute('aria-checked', 'true');
  await enterTab(page, 'series');
  const series = grid(page, 'series');
  await expect(series.getByRole('radio')).toHaveCount(0);
  await series.locator('.dropdown-trigger').click();
  await series.locator('[data-dropdown-value="rating"]').click();
  await series.getByRole('radio', { name: 'Lowest', exact: true }).click();
  await expect(tiles(page, 'series').first()).toHaveText('Title 50');
  await page.reload();
  await enterTab(page, 'movies');
  await expect(grid(page).getByRole('radio', { name: 'Z–A' })).toHaveAttribute('aria-checked', 'true');
  await expect(grid(page).locator('.dropdown-current')).toHaveText('Name');
  await enterTab(page, 'series');
  await expect(grid(page, 'series').getByRole('radio', { name: 'Lowest', exact: true }))
    .toHaveAttribute('aria-checked', 'true');
  await expect(grid(page, 'series').locator('.dropdown-current')).toHaveText('Rating');
});

for (const mode of ['All', 'category']) {
  test(`returns from sorting to the same ${mode} tile until the order changes`, async ({ page }) => {
    if (mode === 'category') {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 });
    }
    await page.goto('/');
    await enterTab(page, 'movies');
    if (mode === 'category') {
      await grid(page).locator('.catalog-cat[data-category-id="1"]').click();
    }
    const layer = grid(page);
    const content = layer.locator('.catalog-grid-track');
    await content.locator('.catalog-tile').first().hover();
    const offset = 3;
    for (let i = 0; i < offset; i++) await page.keyboard.press('ArrowRight');
    const focused = content.locator('.catalog-tile.focused');
    await expect(focused).toHaveAttribute('data-item-id', String(100 + offset));
    await page.keyboard.press('ArrowUp');
    await expect(layer.locator('.catalog-sort .focused')).toHaveCount(1);
    await page.keyboard.press('ArrowDown');
    await expect(focused).toHaveAttribute('data-item-id', String(100 + offset));
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Enter');
    await layer.locator('[data-dropdown-value="name"]').click();
    await layer.locator('[data-sort-direction="desc"]').click();
    await page.keyboard.press('ArrowDown');
    await expect(focused).toHaveAttribute('data-item-id', '100');
  });
}

test('keeps direction labels and selection readable in every theme', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('iptv_catalog_sort_vod', JSON.stringify({ by: 'name', direction: 'asc' }));
  });
  await page.goto('/');
  await enterTab(page, 'movies');
  const row = grid(page).locator('.catalog-sort');
  for (const theme of THEMES) {
    await page.evaluate(id => { document.documentElement.dataset.theme = id; }, theme.id);
    await expect.poll(() => row.evaluate(el => {
      const luminance = (color: string): number => {
        const channels = color.match(/[\d.]+/g)!.slice(0, 3).map(Number).map(value => {
          const channel = value / 255;
          return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
        });
        return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
      };
      const contrast = (a: string, b: string): number => {
        const values = [luminance(a), luminance(b)];
        return (Math.max(...values) + 0.05) / (Math.min(...values) + 0.05);
      };
      const active = getComputedStyle(el.querySelector('[aria-checked="true"]')!);
      const inactive = getComputedStyle(el.querySelector('[aria-checked="false"]')!);
      return contrast(active.color, active.backgroundColor) >= 4.5
        && contrast(inactive.color, inactive.backgroundColor) >= 4.5
        && Math.max(
          contrast(active.backgroundColor, inactive.backgroundColor),
          contrast(active.borderTopColor, inactive.backgroundColor),
        ) >= 3;
    }), { message: `Direction control contrast in ${theme.id}` }).toBe(true);
  }
});

for (const size of ['80', '150']) {
  test(`sizes to the longest translated option, never below its minimum, independently of the selection, at ${size}% text`, async ({ page }) => {
    await page.addInitScript(textSize => {
      localStorage.setItem('iptv_locale', JSON.stringify('uk'));
      localStorage.setItem('iptv_text_size', JSON.stringify(textSize));
      localStorage.setItem('iptv_catalog_sort_vod', JSON.stringify({ by: 'name', direction: 'asc' }));
    }, size);
    await page.goto('/');
    await enterTab(page, 'movies');
    const row = grid(page).locator('.catalog-sort');
    const trigger = row.locator('.dropdown-trigger');
    const width = await row.locator('.dropdown').evaluate(el => el.getBoundingClientRect().width);
    await trigger.click();
    const measurements = await row.evaluate(el => {
      const dd = el.querySelector<HTMLElement>('.dropdown')!;
      const labels = Array.from(dd.querySelectorAll<HTMLElement>('.dropdown-sizer > span'));
      const widest = Math.max(...labels.map(label => {
        const range = document.createRange();
        range.selectNodeContents(label);
        return range.getBoundingClientRect().width;
      }));
      const style = getComputedStyle(dd.querySelector('.dropdown-sizer')!);
      const buttons = Array.from(el.querySelectorAll<HTMLElement>('.dropdown-trigger, [role="radio"]'));
      return {
        expected: Math.max(widest + parseFloat(style.paddingLeft) + parseFloat(style.paddingRight),
          parseFloat(getComputedStyle(dd).minWidth)),
        width: dd.getBoundingClientRect().width,
        // Focus scales the trigger without changing the row's layout.
        heights: buttons.map(button => parseFloat(getComputedStyle(button).height)),
        centers: buttons.map(button => {
          const box = button.getBoundingClientRect();
          return box.y + box.height / 2;
        }),
        clipped: Array.from(dd.querySelectorAll<HTMLElement>('.dropdown-option'))
          .some(option => option.scrollWidth > option.clientWidth),
        right: el.getBoundingClientRect().right,
        availableRight: el.parentElement!.getBoundingClientRect().right
          - parseFloat(getComputedStyle(el.parentElement!).paddingRight),
      };
    });
    expect(measurements.width).toBeCloseTo(measurements.expected, 0);
    expect(measurements.clipped).toBe(false);
    expect(Math.max(...measurements.heights) - Math.min(...measurements.heights)).toBeLessThan(1);
    expect(Math.max(...measurements.centers) - Math.min(...measurements.centers)).toBeLessThan(1);
    expect(measurements.right).toBeCloseTo(measurements.availableRight, 0);
    for (const by of ['added', 'year', 'rating', 'name', 'default']) {
      if (by !== 'added') await trigger.click();
      await row.locator(`[data-dropdown-value="${by}"]`).click();
      expect(await row.locator('.dropdown').evaluate(el => el.getBoundingClientRect().width)).toBeCloseTo(width, 1);
    }
  });
}

test('keeps a minimum width when every option is short', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('iptv_text_size', JSON.stringify('80'));
  });
  await page.goto('/');
  await enterTab(page, 'movies');
  const dd = grid(page).locator('.catalog-sort .dropdown');
  const { width, content } = await dd.evaluate(el => {
    const style = getComputedStyle(el.querySelector('.dropdown-sizer')!);
    const widest = Math.max(...Array.from(el.querySelectorAll<HTMLElement>('.dropdown-sizer > span')).map(label => {
      const range = document.createRange();
      range.selectNodeContents(label);
      return range.getBoundingClientRect().width;
    }));
    return {
      width: el.getBoundingClientRect().width,
      content: widest + parseFloat(style.paddingLeft) + parseFloat(style.paddingRight),
    };
  });
  expect(content).toBeLessThan(240);
  expect(width).toBeCloseTo(240, 0);
});
