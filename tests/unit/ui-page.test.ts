/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * The settings page writes the user's configuration, which makes it the one place
 * in the plugin where a defect destroys something the user cannot get back. It is
 * exercised here against a stand-in DOM rather than a browser: what matters is
 * what it saves, not how it lays a card out.
 *
 * A stand-in rather than jsdom because the page needs a handful of element
 * lookups and an event listener, and a dependency that large for that little
 * would have to be carried by every consumer of the repository.
 *
 * The page builds itself on load, like `homebridge-ui/server.js`, so each test
 * loads a fresh copy against a fresh set of elements.
 */

const PAGE = '../../homebridge-ui/public/index.js'

/** The subset of an element the page uses. */
class FakeNode {
  readonly children: FakeNode[] = []

  readonly attributes = new Map<string, string>()

  readonly dataset: Record<string, string> = {}

  readonly listeners = new Map<string, ((event?: unknown) => void)[]>()

  className = ''

  value = ''

  checked = false

  disabled = false

  hidden = false

  private text = ''

  constructor(readonly tagName: string) {}

  get textContent(): string {
    return [this.text, ...this.children.map((child) => child.textContent)].join('')
  }

  set textContent(value: string) {
    this.text = value
    this.children.length = 0
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
  }

  append(...nodes: FakeNode[]): void {
    this.children.push(...nodes)
  }

  addEventListener(type: string, handler: (event?: unknown) => void): void {
    const existing = this.listeners.get(type) ?? []
    existing.push(handler)
    this.listeners.set(type, existing)
  }

  /** Fires a listener the page registered, as a click or an edit would. */
  fire(type: string): void {
    for (const handler of this.listeners.get(type) ?? []) {
      handler()
    }
  }

  /** Every node in this subtree, so a test can find a control by its label. */
  descendants(): FakeNode[] {
    return this.children.flatMap((child) => [child, ...child.descendants()])
  }
}

interface Toast {
  success: jest.Mock
  error: jest.Mock
  warning: jest.Mock
  info: jest.Mock
}

interface Page {
  byId: (id: string) => FakeNode
  saved: () => Record<string, unknown>[]
  savedOptions: () => Record<string, unknown>
  toast: Toast
  find: (tag: string, label: string) => FakeNode
  players: () => FakeNode
  /** Player names, which the page renders as editable fields rather than text. */
  names: () => string[]
  savePluginConfig: jest.Mock
  showSpinner: jest.Mock
  hideSpinner: jest.Mock
}

/** Lets the page's promise chains run to completion. */
async function settle(): Promise<void> {
  // Draining the macrotask queue rather than counting microtasks, so a test does
  // not have to know how many awaits deep a handler is.
  for (let index = 0; index < 2; index += 1) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve)
    })
  }
}

/**
 * Load the page against a stand-in DOM.
 *
 * `config` is what `getPluginConfig` answers with, as Homebridge would.
 */
async function load(config: unknown[], request?: jest.Mock): Promise<Page> {
  const elements = new Map<string, FakeNode>()
  for (const id of [
    'players', 'summary', 'timeout', 'manual-host', 'manual-port',
    'manual', 'discover', 'manual-probe', 'toggle-manual', 'toggle-json',
    'reboot-all', 'reboot-all-name', 'reboot-all-name-row',
  ]) {
    elements.set(id, new FakeNode('div'))
  }
  const toast: Toast = { success: jest.fn(), error: jest.fn(), warning: jest.fn(), info: jest.fn() }
  const updates: Record<string, unknown>[][] = []
  const homebridge = {
    getPluginConfig: jest.fn().mockResolvedValue(config),
    updatePluginConfig: jest.fn((blocks: Record<string, unknown>[]) => {
      // Cloned, because the page keeps editing the object it handed over.
      updates.push(JSON.parse(JSON.stringify(blocks)) as Record<string, unknown>[])
      return Promise.resolve()
    }),
    savePluginConfig: jest.fn().mockResolvedValue(undefined),
    request: request ?? jest.fn().mockResolvedValue({ players: [] }),
    showSpinner: jest.fn(),
    hideSpinner: jest.fn(),
    showSchemaForm: jest.fn(),
    hideSchemaForm: jest.fn(),
    toast,
  }
  const document = {
    getElementById: (id: string) => elements.get(id),
    createElement: (tag: string) => new FakeNode(tag),
  }

  // Loaded the way Homebridge's UI would load it — through the module system, on
  // the globals a browser provides — so the coverage report reflects it.
  Object.assign(globalThis, { document, homebridge })
  jest.resetModules()
  require(PAGE)
  // The page reads the configuration asynchronously and renders when it arrives.
  await settle()

  const byId = (id: string): FakeNode => {
    const node = elements.get(id)
    if (node === undefined) {
      throw new Error(`no element ${id}`)
    }
    return node
  }

  return {
    byId,
    toast,
    saved: () => {
      const last = updates.at(-1)?.[0]
      return (last?.devices ?? []) as Record<string, unknown>[]
    },
    savedOptions: () => {
      const last = updates.at(-1)?.[0]
      return (last?.options ?? {}) as Record<string, unknown>
    },
    find: (tag, label) => {
      const match = byId('players').descendants()
        .find((node) => node.tagName === tag && node.textContent === label)
      if (match === undefined) {
        throw new Error(`no <${tag}> labelled ${label}`)
      }
      return match
    },
    players: () => byId('players'),
    names: () => byId('players').descendants()
      .filter((node) => node.attributes.get('maxlength') === '64')
      .map((node) => node.value),
    savePluginConfig: homebridge.savePluginConfig,
    showSpinner: homebridge.showSpinner,
    hideSpinner: homebridge.hideSpinner,
  }
}

const configured = {
  platform: 'BluOS',
  name: 'BluOS',
  devices: [{
    id: '90:56:82:0A:00:02:11000',
    name: 'Zone One',
    host: '192.168.4.11',
    port: 11_000,
    volumeSlider: true,
    mute: true,
    battery: false,
    sliderService: 'lightbulb',
    volumePresets: [{ name: 'Bedtime', volume: 12 }],
  }],
  options: { sliderService: 'fan' },
}

/**
 * Tick a labelled checkbox, the way a click would.
 *
 * Found through the label's `for`, because the checkbox itself carries no text
 * and the page generates its id.
 */
function tick(page: Page, label: string): void {
  const id = page.find('label', label).attributes.get('for')
  const input = page.players().descendants()
    .find((node) => node.tagName === 'input' && node.attributes.get('id') === id)
  if (input === undefined) {
    throw new Error(`no checkbox labelled ${label}`)
  }
  input.checked = !input.checked
  input.fire('change')
}

/** The one device the page has pushed into Homebridge. */
async function saveOne(page: Page): Promise<Record<string, unknown>> {
  await settle()
  const devices = page.saved()
  expect(devices).toHaveLength(1)
  return devices[0] as Record<string, unknown>
}

describe('the settings page', () => {
  it('shows a configured player before discovery has run', async () => {
    const page = await load([configured])

    expect(page.players().textContent).toContain('192.168.4.11:11000')
    expect(page.byId('summary').textContent).toBe('1 player(s), 3 HomeKit accessory(s).')
  })

  it('pushes the form into Homebridge and leaves disk save to the footer button', async () => {
    const page = await load([configured])

    expect(page.savePluginConfig).not.toHaveBeenCalled()
    expect((await saveOne(page)).mute).toBe(true)

    tick(page, 'Mute switch')
    expect((await saveOne(page)).mute).toBe(false)
    expect(page.savePluginConfig).not.toHaveBeenCalled()
  })

  it('leaves the reboot switch off until it is ticked, and counts it once it is', async () => {
    // Off by default because restarting a player interrupts whatever it is
    // doing, which is not something to inherit from pressing Discover.
    const page = await load([configured])

    expect((await saveOne(page)).reboot).toBe(false)

    tick(page, 'Reboot switch (reboots this player, and any zone on the same device)')

    expect((await saveOne(page)).reboot).toBe(true)
  })

  it('puts the reboot switch on its own row, with or without a battery checkbox', async () => {
    const page = await load([configured])
    const row = page.players().descendants()
      .find((node) => node.className.includes('bluos-options-reboot'))
    expect(row).toBeDefined()
  })

  it('counts a reboot switch in the accessory total', async () => {
    const page = await load([{
      ...configured,
      devices: [{ ...configured.devices[0], reboot: true }],
    }])

    expect(page.byId('summary').textContent).toBe('1 player(s), 4 HomeKit accessory(s).')
  })

  it('says so plainly when there is nothing configured yet', async () => {
    const page = await load([])

    expect(page.players().textContent).toContain('No players yet')
    expect(page.byId('summary').textContent).toBe('Nothing selected.')
  })

  describe('the reboot all switch', () => {
    it('is off, with its name field hidden, until it is switched on', async () => {
      const page = await load([configured])

      expect(page.byId('reboot-all').checked).toBe(false)
      expect(page.byId('reboot-all-name-row').hidden).toBe(true)

      page.byId('reboot-all').checked = true
      page.byId('reboot-all').fire('change')

      expect(page.byId('reboot-all-name-row').hidden).toBe(false)
    })

    it('saves the name the user typed', async () => {
      const page = await load([configured])
      page.byId('reboot-all').checked = true
      page.byId('reboot-all').fire('change')
      page.byId('reboot-all-name').value = 'Restart Everything'
      page.byId('reboot-all-name').fire('input')
      await settle()

      expect(page.savedOptions()).toMatchObject({
        rebootAll: true,
        rebootAllName: 'Restart Everything',
      })
    })

    it('trims the name, and drops it when left blank', async () => {
      // A blank name must not be saved: the plugin's default is better than an
      // accessory called nothing at all.
      const page = await load([configured])
      page.byId('reboot-all').checked = true
      page.byId('reboot-all').fire('change')
      page.byId('reboot-all-name').value = '   '
      page.byId('reboot-all-name').fire('input')
      await settle()

      expect(page.savedOptions()).toEqual({ sliderService: 'fan', rebootAll: true })
    })

    it('shows the saved name when the page is reopened', async () => {
      const page = await load([{
        ...configured,
        options: { rebootAll: true, rebootAllName: 'Downstairs Reboot' },
      }])

      expect(page.byId('reboot-all').checked).toBe(true)
      expect(page.byId('reboot-all-name').value).toBe('Downstairs Reboot')
      expect(page.byId('reboot-all-name-row').hidden).toBe(false)
    })

    it('forgets the name when the switch is turned off', async () => {
      const page = await load([{
        ...configured,
        options: { rebootAll: true, rebootAllName: 'Downstairs Reboot' },
      }])
      page.byId('reboot-all').checked = false
      page.byId('reboot-all').fire('change')
      await settle()

      expect(page.savedOptions()).toEqual({})
    })

    it('does not mutate the live objects getPluginConfig returned', async () => {
      // getPluginConfig hands back live objects, so editing a control in place
      // would change the configuration of a user who then closed the page.
      const block = { ...configured, options: { sliderService: 'fan' } }
      const page = await load([block])

      page.byId('reboot-all').checked = true
      page.byId('reboot-all').fire('change')

      expect(block.options).toEqual({ sliderService: 'fan' })
    })

    it('counts towards the accessory total even with no players', async () => {
      const page = await load([{ ...configured, devices: [], options: { rebootAll: true } }])

      expect(page.byId('summary').textContent).toBe('0 player(s), 1 HomeKit accessory(s).')
    })
  })

  it('keeps a setting it does not model, rather than dropping it on save', async () => {
    // The page has no control for sliderService, so rebuilding the device from
    // what it does model would silently discard an advanced-editor override.
    const page = await load([configured])

    const device = await saveOne(page)

    expect(device.sliderService).toBe('lightbulb')
    expect(device.id).toBe('90:56:82:0A:00:02:11000')
    expect(device.volumePresets).toEqual([{ name: 'Bedtime', volume: 12 }])
  })

  it('removes the preset list when the last preset is deleted', async () => {
    // Carrying the previous list forward would reinstate a switch the user just
    // deleted, and the accessory would come back on the next restart.
    const page = await load([configured])

    page.find('button', 'Remove').fire('click')
    const device = await saveOne(page)

    expect(device).not.toHaveProperty('volumePresets')
  })

  it('clamps a preset volume typed outside the usable range', async () => {
    const page = await load([configured])
    const volume = page.players().descendants()
      .find((node) => node.attributes.get('max') === '100')
    if (volume === undefined) {
      throw new Error('no preset volume field')
    }

    volume.value = '400'
    volume.fire('input')
    const device = await saveOne(page)

    expect(device.volumePresets).toEqual([{ name: 'Bedtime', volume: 100 }])
  })

  it('drops a player the user unticked, without touching the others', async () => {
    const page = await load([configured])
    const include = page.players().descendants()
      .find((node) => node.attributes.get('aria-label') === 'Expose this player in HomeKit')
    if (include === undefined) {
      throw new Error('no include control')
    }

    include.checked = false
    include.fire('change')
    await settle()

    expect(page.saved()).toEqual([])
    expect(page.toast.error).not.toHaveBeenCalled()
  })

  it('hides the battery switch unless the player has a pack', async () => {
    const page = await load([configured])

    expect(page.players().textContent).not.toContain('Battery (')
    expect(page.players().textContent).not.toContain('no pack fitted')
  })

  it('offers a battery switch on a player that has a pack', async () => {
    const request = jest.fn().mockResolvedValue({
      players: [{
        id: '90:56:82:0A:00:04:11000',
        name: 'Portable Speaker',
        host: '192.168.4.13',
        port: 11_000,
        brand: 'Bluesound',
        model: 'PULSE FLEX 2i',
        firmware: '4.16.6',
        fixedVolume: false,
        hasBattery: true,
        derivedIdentity: false,
        suggested: { volumeSlider: true, mute: false, battery: true },
      }],
    })
    const page = await load([], request)
    page.byId('manual-host').value = '192.168.4.13'
    page.byId('manual-probe').fire('click')
    await settle()

    expect(page.players().textContent).toContain('Battery (on the volume or mute tile')
    expect(page.players().textContent).not.toContain('no pack fitted')
  })

  it('drops a leftover battery accessory once discovery sees no pack', async () => {
    const request = jest.fn().mockResolvedValue({
      players: [{
        id: configured.devices[0].id,
        name: 'Zone One',
        host: '192.168.4.11',
        port: 11_000,
        brand: 'NAD',
        model: 'C658',
        firmware: '4.16.6',
        fixedVolume: false,
        hasBattery: false,
        derivedIdentity: false,
        suggested: { volumeSlider: true, mute: false, battery: false },
      }],
    })
    const page = await load([{
      ...configured,
      devices: [{ ...configured.devices[0], battery: true }],
    }], request)

    expect(page.players().textContent).toContain('Battery (on the volume or mute tile')

    page.byId('discover').fire('click')
    await settle()

    expect(page.players().textContent).not.toContain('Battery (')
    expect((await saveOne(page)).battery).toBe(false)
  })

  it('shows Homebridge\'s spinner and a discovering toast', async () => {
    // The overlay can sit below the fold on a long page. The toast is drawn
    // on the Config UI chrome, so it stays visible for the start of the scan.
    let finish: (value: { players: unknown[] }) => void = () => undefined
    const request = jest.fn().mockReturnValue(new Promise((resolve) => {
      finish = resolve
    }))
    const page = await load([configured], request)

    page.byId('discover').fire('click')
    await settle()

    expect(page.showSpinner).toHaveBeenCalled()
    expect(page.toast.info).toHaveBeenCalledWith('Listening for players…', 'Discovering')
    expect(page.hideSpinner).not.toHaveBeenCalled()

    finish({ players: [] })
    await settle()

    expect(page.hideSpinner).toHaveBeenCalled()
  })

  it('leaves the volume slider off on a newly found player', async () => {
    // Same reason as the reboot switch: Discover listing a player is not the
    // user asking for a HomeKit accessory. A checked slider on every zone
    // would mint a fan tile for each one the moment they Save.
    const request = jest.fn().mockResolvedValue({
      players: [{
        id: '90:56:82:0A:00:03:11000',
        name: 'Soundbar',
        host: '192.168.4.12',
        port: 11_000,
        brand: 'Bluesound',
        model: 'PULSE SOUNDBAR+',
        firmware: '4.16.6',
        fixedVolume: false,
        hasBattery: false,
        derivedIdentity: false,
        suggested: { volumeSlider: true, mute: false, battery: false },
      }],
    })
    const page = await load([], request)
    page.byId('discover').fire('click')
    await settle()

    const include = page.players().descendants()
      .find((node) => node.attributes.get('aria-label') === 'Expose this player in HomeKit')
    if (include === undefined) {
      throw new Error('no include control')
    }
    include.checked = true
    include.fire('change')
    const device = await saveOne(page)

    expect(device.volumeSlider).toBe(false)
    expect(device.mute).toBe(false)
  })

  it('keeps a configured volume slider after discovery', async () => {
    const request = jest.fn().mockResolvedValue({
      players: [{
        id: configured.devices[0].id,
        name: 'Zone One',
        host: '192.168.4.11',
        port: 11_000,
        brand: 'NAD',
        model: 'C658',
        firmware: '4.16.6',
        fixedVolume: false,
        hasBattery: false,
        derivedIdentity: false,
        suggested: { volumeSlider: false, mute: false, battery: false },
      }],
    })
    const page = await load([configured], request)
    page.byId('discover').fire('click')
    await settle()

    expect((await saveOne(page)).volumeSlider).toBe(true)
  })

  it('flags a configured player that discovery no longer finds', async () => {
    const request = jest.fn().mockResolvedValue({
      players: [{
        id: '90:56:82:0A:00:03:11000',
        name: 'Soundbar',
        host: '192.168.4.12',
        port: 11_000,
        brand: 'Bluesound',
        model: 'PULSE SOUNDBAR+',
        firmware: '4.16.6',
        fixedVolume: false,
        hasBattery: false,
        derivedIdentity: false,
        suggested: { volumeSlider: true, mute: false, battery: false },
      }],
    })
    const page = await load([configured], request)

    page.byId('discover').fire('click')
    await settle()

    expect(request).toHaveBeenCalledWith('/discover', { timeoutSec: 5 })
    expect(page.names()).toEqual(['Zone One', 'Soundbar'])
    // Discovered but not yet chosen, so the configured player is all that saves.
    expect(page.byId('summary').textContent).toBe('1 player(s), 3 HomeKit accessory(s).')
    expect(page.toast.success).toHaveBeenCalledWith('Found 1 zone(s).', 'Discovery complete')
  })

  it('explains a failed discovery instead of leaving the page silent', async () => {
    const request = jest.fn().mockRejectedValue({ error: 'multicast is filtered' })
    const page = await load([configured], request)

    page.byId('discover').fire('click')
    await settle()

    expect(page.toast.error).toHaveBeenCalledWith('multicast is filtered', 'Discovery failed')
    expect(page.hideSpinner).toHaveBeenCalled()
  })

  it('refuses to probe with nothing entered', async () => {
    const request = jest.fn()
    const page = await load([configured], request)

    page.byId('manual-probe').fire('click')

    expect(request).not.toHaveBeenCalled()
    expect(page.toast.info).not.toHaveBeenCalled()
    expect(page.toast.error).toHaveBeenCalledWith(
      'Enter an IP address or hostname.',
      'Nothing to probe',
    )
  })

  it('selects a player found by address, since asking for it is choosing it', async () => {
    const request = jest.fn().mockResolvedValue({
      players: [{
        id: '90:56:82:0A:00:04:11000',
        name: 'Portable Speaker',
        host: '192.168.4.13',
        port: 11_000,
        brand: 'Bluesound',
        model: 'PULSE FLEX 2i',
        firmware: '4.16.6',
        fixedVolume: false,
        hasBattery: true,
        derivedIdentity: false,
        suggested: { volumeSlider: true, mute: false, battery: true },
      }],
    })
    const page = await load([], request)
    page.byId('manual-host').value = '192.168.4.13'
    page.byId('manual-port').value = '11000'

    page.byId('manual-probe').fire('click')
    await settle()

    expect(request).toHaveBeenCalledWith('/probe', { host: '192.168.4.13', port: 11_000 })
    expect(page.toast.info).toHaveBeenCalledWith('Probing 192.168.4.13…', 'Probing')
    const device = await saveOne(page)
    expect(device).toMatchObject({
      id: '90:56:82:0A:00:04:11000',
      battery: true,
      volumeSlider: false,
    })
  })

  it('offers no slider for a fixed-output player', async () => {
    const request = jest.fn().mockResolvedValue({
      players: [{
        id: '90:56:82:0A:00:05:11000',
        name: 'Fixed Output',
        host: '192.168.4.14',
        port: 11_000,
        brand: 'NAD',
        model: 'CI 580',
        firmware: '4.16.6',
        fixedVolume: true,
        hasBattery: false,
        derivedIdentity: false,
        suggested: { volumeSlider: false, mute: true, battery: false },
      }],
    })
    const page = await load([], request)

    page.byId('manual-probe').fire('click')
    expect(page.toast.error).toHaveBeenCalled()

    page.byId('manual-host').value = '192.168.4.14'
    page.byId('manual-probe').fire('click')
    await settle()

    expect(page.players().textContent).toContain('fixed volume')
    const device = await saveOne(page)
    expect(device.volumeSlider).toBe(false)
    expect(device.mute).toBe(true)
  })

  it('renders an empty page when the stored devices are not a list', async () => {
    const page = await load([{ platform: 'BluOS', devices: 'not a list' }])

    expect(page.players().textContent).toContain('No players yet')
    expect(page.saved()).toEqual([])
  })

  it('shows the schema form only when it is asked for', async () => {
    const page = await load([configured])

    page.byId('toggle-json').fire('click')
    page.byId('toggle-json').fire('click')

    expect(page.byId('summary').textContent).toContain('player(s)')
  })
})
