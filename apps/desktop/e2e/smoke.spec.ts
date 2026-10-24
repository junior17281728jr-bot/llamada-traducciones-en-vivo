/**
 * Browser smoke test in Chromium (not Electron) against a REAL server in simulated mode started by
 * e2e/global-setup.ts: log in, receive a simulated call through /sim, check that the screen says
 * "Simulado", that the passenger waveform moves while the passenger speaks and the operator one does
 * not (and the other way round when the operator speaks), hang up and find the call in the history.
 *
 * Everything here is simulated: synthetic audio, mock providers. It proves nothing about real services.
 */
import { expect, test, type Page } from '@playwright/test';
import { ENV_PASSWORD, ENV_SERVER_URL, ENV_USERNAME } from './global-setup.js';

const PASSENGER_NUMBER = '+447700900123';
const PASSENGER_LINE = 'my flight was cancelled and I need a hotel';
const EXPECTED_TRANSLATION = 'Mi vuelo fue cancelado y necesito un hotel.';
const OPERATOR_LINE = 'voy a comprobar las opciones de alojamiento disponibles';

function serverUrl(): string {
  const url = process.env[ENV_SERVER_URL];
  if (!url) throw new Error('global-setup no arrancó el servidor');
  return url;
}

/** A simulated passenger phone on the server's /sim WebSocket (Node's global WebSocket). */
class SimPhone {
  readonly states: { state: string; reason?: string }[] = [];
  heardBytes = 0;
  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as { type: string; state?: string; reason?: string; audio?: string };
      if (message.type === 'sim.state' && message.state) this.states.push({ state: message.state, ...(message.reason ? { reason: message.reason } : {}) });
      if (message.type === 'sim.audio' && message.audio) this.heardBytes += Buffer.from(message.audio, 'base64').byteLength;
    });
  }

  static connect(url: string): Promise<SimPhone> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      socket.addEventListener('open', () => resolve(new SimPhone(socket)));
      socket.addEventListener('error', () => reject(new Error(`No se pudo conectar con ${url}`)));
    });
  }

  send(message: Record<string, unknown>): void {
    this.socket.send(JSON.stringify(message));
  }

  async waitFor(predicate: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`Tiempo agotado esperando ${what}; estados: ${JSON.stringify(this.states)}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  close(): void {
    this.socket.close();
  }
}

async function login(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByTestId('login-screen')).toBeVisible();
  await page.getByLabel('Servidor').fill(serverUrl());
  await page.getByLabel('Usuario').fill(process.env[ENV_USERNAME]!);
  await page.getByLabel('Contraseña').fill(process.env[ENV_PASSWORD]!);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.getByTestId('topbar-name')).toHaveText('Ana');
  await expect(page.getByTestId('connection-status')).toContainText('Conectado');
}

/** Pixels of a lane's waveform canvas, as a data URL (same input = same string). */
async function canvasPixels(page: Page, speaker: 'passenger' | 'operator'): Promise<string> {
  return page.evaluate((who) => {
    const canvas = document.querySelector<HTMLCanvasElement>(`section[data-speaker="${who}"] canvas`);
    if (!canvas) throw new Error(`No hay canvas para ${who}`);
    return canvas.toDataURL();
  }, speaker);
}

async function waitForCanvasChange(page: Page, speaker: 'passenger' | 'operator', baseline: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const now = await canvasPixels(page, speaker);
    if (now !== baseline) return now;
    if (Date.now() > deadline) throw new Error(`La onda de ${speaker} no cambió en ${timeoutMs} ms`);
    await page.waitForTimeout(100);
  }
}

test.describe('llamada simulada de punta a punta (servidor real en modo simulado + Chromium)', () => {
  test.describe.configure({ mode: 'serial' });

  test('entra, se contesta, dice «Simulado», cada onda sigue a su persona, se cuelga y queda en el historial', async ({ page }) => {
    test.setTimeout(90_000);
    await login(page);
    // Simulated providers and the simulated telephone are labelled in the top bar.
    await expect(page.getByTestId('topbar').getByText('Simulado', { exact: true })).toBeVisible();
    await expect(page.getByTestId('service-elevenlabs')).toContainText('Simulado');

    const phone = await SimPhone.connect(`${serverUrl().replace(/^http/, 'ws')}/sim`);
    try {
      phone.send({ type: 'sim.incoming', from: PASSENGER_NUMBER, lang: 'en' });
      await phone.waitFor(() => phone.states.some((s) => s.state === 'ringing'), 'que suene');

      // The incoming banner offers the call; the operator answers.
      const banner = page.getByTestId('incoming-banner');
      await expect(banner).toBeVisible();
      await expect(page.getByTestId('incoming-from')).toContainText(PASSENGER_NUMBER);
      await banner.getByRole('button', { name: 'Contestar', exact: true }).click();
      await phone.waitFor(() => phone.states.some((s) => s.state === 'active'), 'que la llamada esté activa');

      const screen = page.getByTestId('call-screen');
      await expect(screen).toHaveAttribute('data-state', 'active');
      await expect(screen).toHaveAttribute('data-direction', 'inbound');
      await expect(screen.locator('.call__bar').getByText('Simulado', { exact: true })).toBeVisible();
      await expect(screen.getByText(PASSENGER_NUMBER)).toBeVisible();

      const passengerLane = page.locator('section[data-speaker="passenger"]');
      const operatorLane = page.locator('section[data-speaker="operator"]');
      await expect(passengerLane.getByRole('heading', { name: 'Pasajero' })).toBeVisible();
      await expect(operatorLane.getByRole('heading', { name: 'Operador' })).toBeVisible();
      // Levels are flowing (digital silence) on both lanes before anybody speaks: no "no llega el audio" notice.
      await page.waitForTimeout(800);
      await expect(passengerLane.getByText('No llega el audio')).toHaveCount(0);
      await expect(operatorLane.getByText('No llega el audio')).toHaveCount(0);
      await expect(passengerLane).toHaveAttribute('data-speaking', 'false');

      // Baseline: both waveforms flat and still.
      const passengerFlat = await canvasPixels(page, 'passenger');
      const operatorFlat = await canvasPixels(page, 'operator');
      await page.waitForTimeout(500);
      expect(await canvasPixels(page, 'passenger')).toBe(passengerFlat);
      expect(await canvasPixels(page, 'operator')).toBe(operatorFlat);

      // The passenger speaks: only the passenger waveform moves; the text and its translation appear.
      phone.send({ type: 'sim.say', text: PASSENGER_LINE, lang: 'en' });
      await expect(passengerLane).toHaveAttribute('data-speaking', 'true', { timeout: 10_000 });
      await waitForCanvasChange(page, 'passenger', passengerFlat, 5_000);
      expect(await canvasPixels(page, 'operator')).toBe(operatorFlat);
      await expect(passengerLane.getByText(PASSENGER_LINE)).toBeVisible({ timeout: 15_000 });
      await expect(passengerLane.getByText(EXPECTED_TRANSLATION)).toBeVisible({ timeout: 15_000 });
      expect(await canvasPixels(page, 'operator')).toBe(operatorFlat);

      // The operator answers through the simulated voice box (headless Chromium has no microphone, and the
      // operator waveform shows ONLY the real local microphone: the server's synthetic voice is translated
      // and heard by the passenger, but the lane stays flat and still).
      await expect(operatorLane.getByText('No se encontró ningún micrófono')).toHaveCount(0);
      const debugBox = page.getByRole('form', { name: 'Probar con voz simulada' });
      await expect(debugBox).toBeVisible();
      await debugBox.getByLabel('Frase de prueba').fill(OPERATOR_LINE);
      await debugBox.getByRole('button', { name: 'Dices tú (en español)' }).click();
      await expect(operatorLane.getByText(OPERATOR_LINE)).toBeVisible({ timeout: 15_000 });
      await expect(operatorLane.getByText('I will check the available accommodation options.')).toBeVisible({ timeout: 15_000 });
      await phone.waitFor(() => phone.heardBytes > 20_000, 'que el pasajero oiga la voz traducida', 20_000);
      expect(await canvasPixels(page, 'operator')).toBe(operatorFlat);

      // Hang up from the screen: the phone sees the end and the screen explains it.
      await screen.getByRole('button', { name: 'Colgar' }).click();
      await phone.waitFor(() => phone.states.some((s) => s.state === 'ended'), 'que termine la llamada');
      expect(phone.states.at(-1)).toMatchObject({ state: 'ended', reason: 'hangup_operator' });
      await expect(screen).toHaveAttribute('data-state', 'ended');
      await expect(screen.getByText('Has colgado')).toBeVisible();
      await screen.getByRole('button', { name: 'Cerrar' }).click();
      await expect(page.getByTestId('idle-panel')).toContainText('Esperando llamadas');

      // The call is in the history with its number and a recording.
      await page.getByRole('tab', { name: 'Historial' }).click();
      const row = page.getByTestId('history-row').first();
      await expect(row).toBeVisible({ timeout: 10_000 });
      await expect(row).toContainText(PASSENGER_NUMBER);
      await expect(row).toContainText('Entrante');
      await expect(row.locator('[data-label="Grabación"]')).toHaveText('Sí');
    } finally {
      phone.close();
    }
  });
});

test.describe('pantalla de inicio en Chromium', () => {
  // One theme, white and Tairs blue, whatever the system prefers.
  for (const colorScheme of ['dark', 'light'] as const) {
    test.describe(`sistema en modo ${colorScheme === 'dark' ? 'oscuro' : 'claro'}`, () => {
      test.use({ colorScheme });

      test('la pantalla de inicio de sesión es blanca y azul', async ({ page }) => {
        await page.goto('/');
        await expect(page.getByRole('heading', { name: 'Telecomway' })).toBeVisible();
        await expect(page.getByTestId('login-screen')).toBeVisible();
        expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(243, 247, 253)');
        expect(await page.evaluate(() => getComputedStyle(document.querySelector('.card')!).backgroundColor)).toBe('rgb(255, 255, 255)');
        expect(await page.evaluate(() => getComputedStyle(document.querySelector('.button--primary')!).backgroundColor)).toBe('rgb(31, 95, 214)');
      });
    });
  }

  test('no desborda horizontalmente a 360 px', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 640 });
    await page.goto('/');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test('explica un servidor inalcanzable al iniciar sesión', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Servidor').fill('http://127.0.0.1:1');
    await page.getByLabel('Usuario').fill('nadie');
    await page.getByLabel('Contraseña').fill('nada');
    await page.getByRole('button', { name: 'Entrar' }).click();
    await expect(page.getByRole('alert')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('login-screen')).toBeVisible();
  });
});
