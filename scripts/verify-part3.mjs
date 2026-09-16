import { chromium } from 'playwright';

const BASE_URL = 'http://localhost:5174';

function makeEmail(prefix) {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 10000)}@example.com`;
}

function logCheck(name, pass, details = '') {
  const status = pass ? 'YES' : 'NO';
  console.log(`[${status}] ${name}${details ? ` :: ${details}` : ''}`);
}

async function register(page, name, email, password) {
  await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Sign up' }).click();
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForTimeout(1200);
}

async function ensureDashboard(page, email, password) {
  if (await page.getByText('Your files').isVisible().catch(() => false)) {
    return true;
  }

  if (!/\/login/.test(page.url())) {
    await page.goto(`${BASE_URL}/login`, { waitUntil: 'domcontentloaded' });
  }

  if (await page.getByRole('button', { name: 'Sign in' }).first().isVisible().catch(() => false)) {
    await page.getByRole('button', { name: 'Sign in' }).first().click();
  }

  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).nth(1).click();
  await page.waitForURL(/\/$/, { timeout: 15000 });
  return page.getByText('Your files').isVisible().catch(() => false);
}

async function drawOnCanvas(page, from, to) {
  const canvas = page.locator('.konvajs-content canvas').first();
  await canvas.waitFor({ state: 'visible', timeout: 20000 });
  const box = await canvas.boundingBox();
  if (!box) throw new Error('Canvas not visible');

  await page.mouse.move(box.x + from.x, box.y + from.y);
  await page.mouse.down();
  await page.mouse.move(box.x + to.x, box.y + to.y);
  await page.mouse.up();
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context1 = await browser.newContext();
  const context2 = await browser.newContext();

  const page1 = await context1.newPage();
  const page2 = await context2.newPage();

  const checks = [];
  const push = (name, pass, details = '') => {
    checks.push({ name, pass, details });
    logCheck(name, pass, details);
  };

  const user1 = {
    name: 'Owner User',
    email: makeEmail('owner'),
    password: 'Password123!'
  };

  const user2 = {
    name: 'Collaborator User',
    email: makeEmail('collab'),
    password: 'Password123!'
  };

  try {
    await register(page1, user1.name, user1.email, user1.password);
    const ownerOnDashboard = await ensureDashboard(page1, user1.email, user1.password);
    const newFileVisible = await page1.getByRole('button', { name: '+ New file' }).isVisible().catch(() => false);
    push('Login/Register to dashboard', ownerOnDashboard || newFileVisible);

    let openedByUi = false;
    try {
      await page1.getByRole('button', { name: '+ New file' }).click({ timeout: 5000 });
      await page1.waitForURL(/\/editor\//, { timeout: 10000 });
      openedByUi = true;
    } catch {
      const createViaApi = await page1.evaluate(async () => {
        const refreshRes = await fetch('/api/auth/refresh', {
          method: 'POST',
          credentials: 'include',
        });
        if (!refreshRes.ok) return { ok: false };
        const refreshData = await refreshRes.json();
        const createRes = await fetch('/api/documents', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${refreshData.accessToken}`,
          },
          body: JSON.stringify({ title: 'Untitled' }),
        });
        if (!createRes.ok) return { ok: false };
        const doc = await createRes.json();
        return { ok: true, id: doc.id };
      });

      if (!createViaApi.ok || !createViaApi.id) {
        throw new Error('Could not create document via UI or API');
      }

      await page1.goto(`${BASE_URL}/editor/${createViaApi.id}`, { waitUntil: 'domcontentloaded' });
      await page1.waitForURL(/\/editor\//, { timeout: 10000 });
    }
    const editorUrl = page1.url();
    const docId = editorUrl.split('/editor/')[1];
    push('Create/Open document', !!docId, openedByUi ? 'created via UI' : 'created via API fallback');

    const connectedLocator = page1.getByText('Connected').first();
    await connectedLocator.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
    const connectedVisible = await connectedLocator.isVisible().catch(() => false);
    push('Connected indicator', connectedVisible);

    await page1.locator('button[title="Rectangle (R)"]').click();
    await drawOnCanvas(page1, { x: 120, y: 120 }, { x: 260, y: 220 });
    const noObjectsText = page1.getByText('No objects yet. Draw something!');
    push('Canvas draw', !(await noObjectsText.isVisible().catch(() => false)));

    await page1.locator('button[title="Select (V)"]').click();
    const firstLayerItem = page1.locator('aside button').first();
    await firstLayerItem.click({ timeout: 10000 });
    const fillLabelVisible = await page1.getByText('Fill').first().isVisible({ timeout: 10000 }).catch(() => false);
    push('Select + Fill/Layers visible', fillLabelVisible);

    const beforeUndoCount = await page1.locator('.konvajs-content canvas').count();
    await page1.keyboard.press('Control+KeyZ');
    await page1.waitForTimeout(300);
    const noObjectsAfterUndo = await page1.getByText('No objects yet. Draw something!').isVisible().catch(() => false);
    await page1.keyboard.press('Control+KeyY');
    await page1.waitForTimeout(300);
    const noObjectsAfterRedo = await page1.getByText('No objects yet. Draw something!').isVisible().catch(() => false);
    push('Undo/Redo', noObjectsAfterUndo && !noObjectsAfterRedo, `canvasCount=${beforeUndoCount}`);

    await page1.getByRole('button', { name: 'Share' }).click();
    await page1.locator('input[type="email"]').last().fill(user2.email);
    await page1.getByRole('button', { name: 'Generate OTP' }).click();
    const otpText = await page1.getByText(/OTP:\s*\d{6}/).first().textContent({ timeout: 15000 });
    const otp = otpText?.match(/(\d{6})/)?.[1] ?? '';
    push('Share OTP generation', otp.length === 6, otpText ?? '');

    await register(page2, user2.name, user2.email, user2.password);
    await ensureDashboard(page2, user2.email, user2.password);
    const verifyResult = await page2.evaluate(async ({ docId, otp, email, password }) => {
      const loginRes = await fetch('/api/auth/login', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      if (!loginRes.ok) {
        return { ok: false, reason: `login_${loginRes.status}` };
      }
      const loginData = await loginRes.json();
      const token = loginData.accessToken;

      const verifyRes = await fetch(`/api/documents/${docId}/verify-otp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ otp }),
      });

      const body = await verifyRes.json().catch(() => null);
      return { ok: verifyRes.ok, status: verifyRes.status, body };
    }, { docId, otp, email: user2.email, password: user2.password });

    push('OTP verification for collaborator', !!verifyResult.ok, JSON.stringify(verifyResult));

    await page2.evaluate((targetDocId) => {
      window.history.pushState({}, '', `/editor/${targetDocId}`);
      window.dispatchEvent(new PopStateEvent('popstate'));
    }, docId);
    await page2.waitForTimeout(1200);
    const page2RectTool = page2.locator('button[title="Rectangle (R)"]');
    await page2RectTool.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
    const page2EditorReady = await page2RectTool.isVisible().catch(() => false);
    push('Second user open same doc', page2EditorReady);

    await page2.locator('button[title="Ellipse (O)"]').click();
    await drawOnCanvas(page2, { x: 300, y: 170 }, { x: 410, y: 260 });
    await page1.waitForTimeout(1200);
    const layerButtons = page1.locator('aside button:has-text("ellipse")');
    const objectCountVisible = (await page1.locator('aside button').count()) >= 2;
    push('Two-user sync in editor', objectCountVisible);

    await page2.mouse.move(420, 220);
    await page2.waitForTimeout(400);
    const activeUserAvatar = page1.locator('div.w-7.h-7.rounded-full').first();
    const activeUsersVisible = await activeUserAvatar.isVisible().catch(() => false);
    push('Remote collaborator/cursor presence', activeUsersVisible);

    const allPass = checks.every((c) => c.pass);
    console.log('--- PART 3 SUMMARY ---');
    for (const c of checks) {
      console.log(`${c.pass ? 'YES' : 'NO'} :: ${c.name}`);
    }
    if (!allPass) {
      process.exitCode = 1;
    }
  } finally {
    await context1.close();
    await context2.close();
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
