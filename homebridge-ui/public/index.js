/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * Custom configuration UI. Discovers BluOS zones and writes them into the plugin
 * configuration, so a user never has to find an IP address or work out which
 * port a multi-zone amplifier uses for its second zone.
 *
 * Player names and models arrive from the network and are therefore untrusted.
 * Every value from a player is inserted with textContent or as a form value,
 * never as HTML, which is why this file builds nodes instead of assembling markup
 * from strings.
 *
 * A separate file rather than an inline script so that the linter and the tests
 * can reach it: it is shipped to users and it writes their configuration.
 */
(() => {
  'use strict'

  const PLATFORM = 'BluOS'

  /** Control port of a primary player, matching DEFAULT_BLUOS_PORT in settings.ts. */
  const DEFAULT_PORT = 11000

  /** Default discovery window, matching DEFAULT_DISCOVERY_TIMEOUT_SEC in settings.ts. */
  const DEFAULT_TIMEOUT_SEC = 5

  /** Every player known to the page, keyed by its stable identity. */
  const players = new Map()

  let platformConfig = { platform: PLATFORM, name: PLATFORM, devices: [], options: {} }
  let schemaFormVisible = false

  const byId = (id) => document.getElementById(id)
  const playersEl = byId('players')

  /** Build an element. Text is always set as text, never parsed as HTML. */
  function el(tag, attributes = {}, text) {
    const node = document.createElement(tag)
    for (const [key, value] of Object.entries(attributes)) {
      if (value === undefined || value === false) {
        continue
      }
      if (key === 'class') {
        node.className = value
      } else if (key === 'dataset') {
        Object.assign(node.dataset, value)
      } else {
        node.setAttribute(key, value === true ? '' : String(value))
      }
    }
    if (text !== undefined) {
      node.textContent = text
    }
    return node
  }

  function describeError(error) {
    if (error && typeof error === 'object') {
      if (error.error) {
        return String(error.error)
      }
      if (error.message) {
        return String(error.message)
      }
    }
    return String(error)
  }

  // --- Configuration ------------------------------------------------------

  async function loadConfig() {
    const blocks = await homebridge.getPluginConfig()
    const existing = Array.isArray(blocks) && blocks.length > 0 ? blocks[0] : undefined
    platformConfig = Object.assign({ platform: PLATFORM, name: PLATFORM }, existing)
    platformConfig.platform = PLATFORM
    if (!Array.isArray(platformConfig.devices)) {
      platformConfig.devices = []
    }
    // Copied rather than aliased: `getPluginConfig` hands back the live objects,
    // and editing a control must not change them. The page pushes a fresh copy
    // into Homebridge; the footer Save is what writes that copy to disk.
    platformConfig.options = typeof platformConfig.options === 'object' && platformConfig.options !== null
      ? Object.assign({}, platformConfig.options)
      : {}
    loadPlatformOptions()

    // Configured players are shown even before discovery runs, so a user can
    // adjust an existing setup without waiting for the network.
    for (const device of platformConfig.devices) {
      if (!device || typeof device.id !== 'string') {
        continue
      }
      players.set(device.id, {
        id: device.id,
        name: device.name || device.host || device.id,
        host: device.host || '',
        port: device.port || DEFAULT_PORT,
        brand: device.brand || 'BluOS',
        model: device.model || '',
        firmware: '',
        fixedVolume: false,
        hasBattery: device.battery === true,
        derivedIdentity: false,
        online: undefined,
        selected: true,
        volumeSlider: device.volumeSlider !== false,
        mute: device.mute === true,
        battery: device.battery === true,
        reboot: device.reboot === true,
        presets: Array.isArray(device.volumePresets)
          ? device.volumePresets.filter((preset) => preset && typeof preset.name === 'string')
            .map((preset) => ({ name: preset.name, volume: Number(preset.volume) || 0 }))
          : [],
        // Kept so that a later push preserves settings this page does not model,
        // such as a per-device sliderService written in the advanced editor.
        // Without it, opening this page and saving would silently discard them.
        saved: device,
      })
    }
  }

  function mergeDiscovered(found) {
    for (const player of found) {
      const existing = players.get(player.id)
      if (existing !== undefined) {
        // Discovery is authoritative about where a player is and what it is,
        // never about what the user chose to expose.
        existing.host = player.host
        existing.port = player.port
        existing.brand = player.brand
        existing.model = player.model
        existing.firmware = player.firmware
        existing.fixedVolume = player.fixedVolume
        existing.hasBattery = player.hasBattery
        existing.online = true
        if (existing.fixedVolume) {
          existing.volumeSlider = false
        }
        if (!existing.hasBattery) {
          existing.battery = false
        }
        continue
      }
      players.set(player.id, {
        id: player.id,
        name: player.name,
        host: player.host,
        port: player.port,
        brand: player.brand,
        model: player.model,
        firmware: player.firmware,
        fixedVolume: player.fixedVolume,
        hasBattery: player.hasBattery,
        derivedIdentity: player.derivedIdentity,
        online: true,
        selected: false,
        // Discover listing a zone is not a request for a HomeKit accessory.
        // Volume is a fan tile; leaving it ticked on every new player would
        // mint one per zone the moment the user pressed Save.
        volumeSlider: false,
        mute: player.suggested.mute,
        battery: player.suggested.battery,
        reboot: player.suggested.reboot,
        presets: [],
        saved: undefined,
      })
    }
  }

  function toDevices() {
    const devices = []
    for (const player of players.values()) {
      if (!player.selected) {
        continue
      }
      const device = Object.assign({}, player.saved, {
        id: player.id,
        name: player.name.trim() || player.host,
        host: player.host,
        port: player.port,
        volumeSlider: player.volumeSlider === true,
        mute: player.mute === true,
        battery: player.battery === true && player.hasBattery === true,
        reboot: player.reboot === true,
      })
      if (player.brand) {
        device.brand = player.brand
      }
      if (player.model) {
        device.model = player.model
      }
      const presets = player.presets
        .filter((preset) => preset.name.trim().length > 0)
        .map((preset) => ({
          name: preset.name.trim(),
          volume: Math.max(0, Math.min(100, Math.round(Number(preset.volume) || 0))),
        }))
      if (presets.length > 0) {
        device.volumePresets = presets
      } else {
        // Removing every preset has to remove the key, or a carried-forward list
        // would reinstate switches the user just deleted.
        delete device.volumePresets
      }
      devices.push(device)
    }
    return devices
  }

  /** Show the saved install-wide settings, and reveal the name field if used. */
  function loadPlatformOptions() {
    byId('reboot-all').checked = platformConfig.options.rebootAll === true
    const name = platformConfig.options.rebootAllName
    byId('reboot-all-name').value = typeof name === 'string' ? name : ''
    refreshRebootAllName()
  }

  /** The name only means anything while the switch exists. */
  function refreshRebootAllName() {
    byId('reboot-all-name-row').hidden = byId('reboot-all').checked !== true
  }

  /**
   * Fold the install-wide settings back into the configuration.
   *
   * An empty name removes the key rather than saving a blank one, so the plugin
   * falls back to its default instead of registering an unnamed accessory.
   */
  function applyPlatformOptions() {
    const enabled = byId('reboot-all').checked === true
    const name = byId('reboot-all-name').value.trim()
    if (enabled) {
      platformConfig.options.rebootAll = true
    } else {
      delete platformConfig.options.rebootAll
    }
    if (enabled && name.length > 0) {
      platformConfig.options.rebootAllName = name
    } else {
      delete platformConfig.options.rebootAllName
    }
  }

  /**
   * Copy the form into Homebridge's in-memory plugin config.
   *
   * The purple footer Save writes that copy to disk. This page does not save on
   * its own: a second Save is easy to miss, and `savePluginConfig` is the same
   * action as that footer button.
   */
  async function pushConfig() {
    platformConfig.devices = toDevices()
    applyPlatformOptions()
    try {
      await homebridge.updatePluginConfig([platformConfig])
    } catch (error) {
      homebridge.toast.error(describeError(error), 'Could not update the configuration')
    }
  }

  function changed() {
    refreshSummary()
    void pushConfig()
  }

  function renderChanged() {
    render()
    void pushConfig()
  }

  // --- Rendering ----------------------------------------------------------

  function renderPresets(player) {
    const wrapper = el('div', { class: 'bluos-presets' })
    player.presets.forEach((preset, index) => {
      const row = el('div', { class: 'bluos-preset-row' })

      const name = el('input', {
        type: 'text',
        class: 'form-control form-control-sm',
        placeholder: 'Preset name, e.g. Bedtime Volume',
      })
      name.value = preset.name
      name.addEventListener('input', () => {
        preset.name = name.value
        changed()
      })

      const volume = el('input', {
        type: 'number', min: '0', max: '100', class: 'form-control form-control-sm',
      })
      volume.value = String(preset.volume)
      volume.addEventListener('input', () => {
        preset.volume = Number(volume.value)
        changed()
      })

      const remove = el('button', { class: 'btn btn-outline-danger btn-sm', type: 'button' }, 'Remove')
      remove.addEventListener('click', () => {
        player.presets.splice(index, 1)
        renderChanged()
      })

      row.append(name, volume, remove)
      wrapper.append(row)
    })

    const add = el('button', { class: 'btn btn-outline-secondary btn-sm', type: 'button' }, 'Add volume preset')
    add.addEventListener('click', () => {
      player.presets.push({ name: '', volume: 30 })
      renderChanged()
    })
    wrapper.append(add)
    return wrapper
  }

  function checkbox(label, checked, disabled, onChange) {
    const wrapper = el('div', { class: 'bluos-check' })
    const id = `opt-${Math.random().toString(36).slice(2)}`
    const input = el('input', { type: 'checkbox', id })
    input.checked = checked
    input.disabled = disabled === true
    input.addEventListener('change', () => {
      onChange(input.checked)
      changed()
    })
    const text = el('label', { for: id }, label)
    wrapper.append(input, text)
    return wrapper
  }

  function renderPlayer(player) {
    const card = el('div', { class: `bluos-card${player.selected ? ' is-selected' : ''}` })
    const head = el('div', { class: 'bluos-card-head' })

    const include = el('input', { type: 'checkbox', class: 'mr-1' })
    include.checked = player.selected
    include.setAttribute('aria-label', 'Expose this player in HomeKit')
    include.addEventListener('change', () => {
      player.selected = include.checked
      renderChanged()
    })

    const title = el('div', { class: 'bluos-card-title' })
    const nameInput = el('input', { type: 'text', class: 'form-control form-control-sm', maxlength: '64' })
    nameInput.value = player.name
    nameInput.addEventListener('input', () => {
      player.name = nameInput.value
      changed()
    })
    title.append(nameInput)

    head.append(include, title)

    if (player.port !== DEFAULT_PORT) {
      head.append(el('span', { class: 'bluos-badge' }, `zone ${player.port}`))
    }
    if (player.fixedVolume) {
      head.append(el('span', { class: 'bluos-badge warn' }, 'fixed volume'))
    }
    if (player.hasBattery) {
      head.append(el('span', { class: 'bluos-badge' }, 'battery'))
    }
    if (player.online === false) {
      head.append(el('span', { class: 'bluos-badge warn' }, 'not found'))
    }

    const metaParts = [player.brand, player.model].filter((part) => part)
    const meta = el('div', { class: 'bluos-meta' })
    meta.textContent = `${metaParts.join(' ')} · ${player.host}:${player.port}`
      + (player.firmware ? ` · firmware ${player.firmware}` : '')
    card.append(head, meta)

    if (player.derivedIdentity) {
      card.append(el(
        'div',
        { class: 'bluos-meta' },
        'This player did not report a MAC address, so an identity was generated for it. '
        + 'Keep it as it is: changing it detaches the accessories from their HomeKit rooms.',
      ))
    }

    const options = el('div', { class: 'bluos-options' })
    options.append(checkbox(
      player.fixedVolume ? 'Volume slider (unavailable: fixed output)' : 'Volume slider',
      player.volumeSlider && !player.fixedVolume,
      player.fixedVolume,
      (value) => { player.volumeSlider = value },
    ))
    options.append(checkbox('Mute switch', player.mute, false, (value) => { player.mute = value }))
    if (player.hasBattery) {
      options.append(checkbox(
        'Battery (on the volume or mute tile; its own tile only if those are off)',
        player.battery,
        false,
        (value) => { player.battery = value },
      ))
    }
    const reboot = checkbox(
      'Reboot switch (reboots this player, and any zone on the same device)',
      player.reboot,
      false,
      (value) => { player.reboot = value },
    )
    reboot.className += ' bluos-options-reboot'
    options.append(reboot)
    card.append(options)

    if (player.selected) {
      card.append(renderPresets(player))
    }
    return card
  }

  function refreshSummary() {
    const devices = toDevices()
    let tiles = 0
    for (const device of devices) {
      tiles += device.volumeSlider ? 1 : 0
      tiles += device.mute ? 1 : 0
      tiles += device.battery && !device.volumeSlider && !device.mute ? 1 : 0
      tiles += device.reboot ? 1 : 0
      tiles += Array.isArray(device.volumePresets) ? device.volumePresets.length : 0
    }
    // Counted even with no players: it belongs to the install, and it is the one
    // accessory that still does something when `devices[]` is empty.
    tiles += byId('reboot-all').checked === true ? 1 : 0
    byId('summary').textContent = devices.length === 0 && tiles === 0
      ? 'Nothing selected.'
      : `${devices.length} player(s), ${tiles} HomeKit accessory(s).`
  }

  function render() {
    playersEl.textContent = ''
    if (players.size === 0) {
      playersEl.append(el(
        'div',
        { class: 'bluos-empty' },
        'No players yet. Run discovery, or add one by address.',
      ))
    } else {
      const sorted = [...players.values()].sort((left, right) => {
        if (left.host !== right.host) {
          return left.host.localeCompare(right.host)
        }
        return left.port - right.port
      })
      for (const player of sorted) {
        playersEl.append(renderPlayer(player))
      }
    }
    refreshSummary()
  }

  // --- Actions ------------------------------------------------------------

  let requestInFlight = false

  /**
   * Show progress next to Discover, which is where the user just pressed.
   *
   * Homebridge's spinner is centred on the whole settings page. With a long
   * list of players that centre sits below the fold, so a user who pressed
   * Discover would see nothing happen for several seconds.
   */
  function setBusy(isBusy, message) {
    requestInFlight = isBusy
    byId('discover').disabled = isBusy
    byId('manual-probe').disabled = isBusy
    const status = byId('discover-status')
    status.hidden = !isBusy
    status.textContent = isBusy ? message : ''
  }

  async function discover() {
    if (requestInFlight) {
      return
    }
    const timeoutSec = Number(byId('timeout').value) || DEFAULT_TIMEOUT_SEC
    setBusy(true, 'Listening for players…')
    try {
      const response = await homebridge.request('/discover', { timeoutSec })
      const found = Array.isArray(response && response.players) ? response.players : []
      // Anything previously discovered but missing now is flagged rather than
      // removed: a player that is merely switched off should not disappear from a
      // configuration the user already built.
      for (const player of players.values()) {
        if (player.online === true && !found.some((entry) => entry.id === player.id)) {
          player.online = false
        }
      }
      mergeDiscovered(found)
      renderChanged()
      if (found.length === 0) {
        homebridge.toast.warning(
          'No players answered. If multicast is filtered on your network, add a player by address.',
          'Nothing found',
        )
      } else {
        homebridge.toast.success(`Found ${found.length} zone(s).`, 'Discovery complete')
      }
    } catch (error) {
      homebridge.toast.error(describeError(error), 'Discovery failed')
    } finally {
      setBusy(false)
    }
  }

  async function probe() {
    if (requestInFlight) {
      return
    }
    const host = byId('manual-host').value.trim()
    const portValue = byId('manual-port').value.trim()
    if (host.length === 0) {
      homebridge.toast.error('Enter an IP address or hostname.', 'Nothing to probe')
      return
    }
    const payload = { host }
    if (portValue.length > 0) {
      payload.port = Number(portValue)
    }
    setBusy(true, 'Probing…')
    try {
      const response = await homebridge.request('/probe', payload)
      const found = Array.isArray(response && response.players) ? response.players : []
      mergeDiscovered(found)
      for (const entry of found) {
        const player = players.get(entry.id)
        if (player !== undefined) {
          player.selected = true
        }
      }
      renderChanged()
      homebridge.toast.success(`Found ${found.length} zone(s) at ${host}.`, 'Player added')
    } catch (error) {
      homebridge.toast.error(describeError(error), 'Probe failed')
    } finally {
      setBusy(false)
    }
  }

  byId('discover').addEventListener('click', () => void discover())
  byId('manual-probe').addEventListener('click', () => void probe())
  byId('reboot-all').addEventListener('change', () => {
    refreshRebootAllName()
    changed()
  })
  byId('reboot-all-name').addEventListener('input', () => {
    changed()
  })
  byId('toggle-manual').addEventListener('click', () => {
    const panel = byId('manual')
    panel.hidden = !panel.hidden
  })
  byId('toggle-json').addEventListener('click', () => {
    schemaFormVisible = !schemaFormVisible
    if (schemaFormVisible) {
      homebridge.showSchemaForm()
    } else {
      homebridge.hideSchemaForm()
    }
  })

  // The schema form is hidden by default: this page is the primary way to
  // configure the plugin, and showing both at once invites edits in one that the
  // other silently overwrites.
  homebridge.hideSchemaForm()

  loadConfig()
    .then(() => {
      render()
      return pushConfig()
    })
    .catch((error) => {
      homebridge.toast.error(describeError(error), 'Could not read the configuration')
      render()
    })
})()
