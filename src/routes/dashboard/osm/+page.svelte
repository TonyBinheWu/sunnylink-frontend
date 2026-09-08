<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { fade } from 'svelte/transition';
	import {
		Map as MapIcon,
		Download,
		AlertCircle,
		Loader2,
		RefreshCw,
		Navigation,
		X
	} from 'lucide-svelte';
	import { deviceState } from '$lib/stores/device.svelte';
	import { setDeviceParams, checkDeviceStatus, fetchSettingsAsync } from '$lib/api/device';
	import { logtoClient, authState } from '$lib/logto/auth.svelte';
	import { decodeParamValue, encodeParamValue } from '$lib/utils/device';
	import ConfirmationModal from '$lib/components/ConfirmationModal.svelte';
	import type { OSMRegion } from '$lib/types/osm';
	import ComboBox from '$lib/components/ComboBox.svelte';
	import DashboardSkeleton from '../DashboardSkeleton.svelte';
	import SyncStatusIndicator from '$lib/components/SyncStatusIndicator.svelte';
	import SettingsPageShell from '$lib/components/SettingsPageShell.svelte';
	import { createSyncStatus } from '$lib/utils/syncStatus.svelte';
	import { batchPush } from '$lib/stores/batchPush.svelte';
	import { toast } from 'svelte-sonner';
	import { Athenav0Client } from '$lib/api/client';

	interface MapboxFeature {
		id: string;
		name: string;
		details: string;
		latitude: number;
		longitude: number;
	}

	const OSM_CACHE_PREFIX = 'sunnylink_osm_';
	const OSM_CACHE_TTL = 48 * 60 * 60 * 1000; // 48 hours

	interface OsmCacheEntry {
		params: Array<{ key?: string; value?: string; type?: string }>;
		timestamp: number;
	}

	function loadOsmCache(deviceId: string): OsmCacheEntry | null {
		if (typeof localStorage === 'undefined') return null;
		try {
			const raw = localStorage.getItem(`${OSM_CACHE_PREFIX}${deviceId}`);
			if (!raw) return null;
			const entry: OsmCacheEntry = JSON.parse(raw);
			if (Date.now() - entry.timestamp > OSM_CACHE_TTL) {
				localStorage.removeItem(`${OSM_CACHE_PREFIX}${deviceId}`);
				return null;
			}
			return entry;
		} catch {
			return null;
		}
	}

	function saveOsmCache(
		deviceId: string,
		params: Array<{ key?: string; value?: string; type?: string }>
	): void {
		if (typeof localStorage === 'undefined') return;
		try {
			const entry: OsmCacheEntry = { params, timestamp: Date.now() };
			localStorage.setItem(`${OSM_CACHE_PREFIX}${deviceId}`, JSON.stringify(entry));
		} catch {}
	}

	const OSM_PARAMS = [
		'OsmLocationName',
		'OsmLocationTitle',
		'OsmStateName',
		'OsmStateTitle',
		'OSMDownloadProgress',
		'OsmDbUpdatesCheck',
		'OsmDownloadedDate',
		'OsmLocal'
	];
	const NAVIGATION_PARAMS = ['MapboxPublicKey', 'NavDestination'];
	const MAP_PARAMS = [...OSM_PARAMS, ...NAVIGATION_PARAMS];

	let countries: OSMRegion[] = $state([]);
	let states: OSMRegion[] = $state([]);
	let loadingRegions = $state(false);
	let localDownloadingOverride = $state(false);
	let loadingOsmParams = $state(false);
	let clearingCache = $state(false);
	let clearCacheModalOpen = $state(false);
	let error = $state<string | null>(null);
	let mapboxToken = $state('');
	let tokenDevice = $state('');
	let savingToken = $state(false);
	let destinationQuery = $state('');
	let destinationResults = $state<MapboxFeature[]>([]);
	let selectedDestination = $state<MapboxFeature | null>(null);
	let searchingDestination = $state(false);
	let settingDestination = $state(false);
	let cancellingNavigation = $state(false);

	// Sync status indicator (consistent with settings pages)
	let batchActive = $derived(
		deviceState.selectedDeviceId ? batchPush.isActive(deviceState.selectedDeviceId) : false
	);
	let isStale = $derived(
		!!(deviceState.selectedDeviceId && deviceState.valuesStale[deviceState.selectedDeviceId])
	);
	const sync = createSyncStatus(
		() => !isOffline && (isCheckingStatus || loadingOsmParams || batchActive || isStale),
		() => !isOffline && !isCheckingStatus && !loadingOsmParams && !error && !batchActive && !isStale
	);

	let { data } = $props();

	// Synchronous cache hydration — mirrors Models pattern, runs before first render.
	function hydrateOsmCache(did: string) {
		const existing = deviceState.deviceSettings[did];
		const hasOsmData = existing?.some((p) => p.key === 'OsmLocationName');
		if (hasOsmData) return;
		const cached = loadOsmCache(did);
		if (cached) {
			const filtered = (existing || []).filter((i) => i.key && !OSM_PARAMS.includes(i.key));
			deviceState.deviceSettings[did] = [...filtered, ...(cached.params as any)];
		}
	}

	// Hydrate immediately for current device before first render
	if (deviceState.selectedDeviceId) {
		hydrateOsmCache(deviceState.selectedDeviceId);
	}

	// Re-hydrate reactively when device changes
	$effect(() => {
		const did = deviceState.selectedDeviceId;
		if (did) untrack(() => hydrateOsmCache(did));
	});

	let isOffline = $derived(
		deviceState.selectedDeviceId &&
			deviceState.onlineStatuses[deviceState.selectedDeviceId] === 'offline'
	);

	let isCheckingStatus = $derived(
		deviceState.selectedDeviceId &&
			(deviceState.onlineStatuses[deviceState.selectedDeviceId] === 'loading' ||
				deviceState.onlineStatuses[deviceState.selectedDeviceId] === undefined)
	);

	function getParamValue(deviceId: string, key: string): any {
		const settings = deviceState.deviceSettings[deviceId];
		if (!settings) return null;
		const param = settings.find((p) => p.key === key);
		if (!param) return null;
		return decodeParamValue(param);
	}

	// Derived values for the current device
	let currentCountryName = $derived(
		deviceState.selectedDeviceId
			? getParamValue(deviceState.selectedDeviceId, 'OsmLocationName')
			: null
	);
	let currentCountryTitle = $derived(
		deviceState.selectedDeviceId
			? getParamValue(deviceState.selectedDeviceId, 'OsmLocationTitle')
			: null
	);
	let currentStateName = $derived(
		deviceState.selectedDeviceId
			? getParamValue(deviceState.selectedDeviceId, 'OsmStateName')
			: null
	);
	let currentStateTitle = $derived(
		deviceState.selectedDeviceId
			? getParamValue(deviceState.selectedDeviceId, 'OsmStateTitle')
			: null
	);
	let downloadProgressParam = $derived(
		deviceState.selectedDeviceId
			? getParamValue(deviceState.selectedDeviceId, 'OSMDownloadProgress')
			: null
	);
	let dbUpdatesCheck = $derived(
		deviceState.selectedDeviceId
			? getParamValue(deviceState.selectedDeviceId, 'OsmDbUpdatesCheck')
			: null
	);
	let downloadedDateParam = $derived(
		deviceState.selectedDeviceId
			? getParamValue(deviceState.selectedDeviceId, 'OsmDownloadedDate')
			: null
	);
	let osmLocalParam = $derived(
		deviceState.selectedDeviceId ? getParamValue(deviceState.selectedDeviceId, 'OsmLocal') : null
	);
	let currentMapboxToken = $derived(
		deviceState.selectedDeviceId
			? String(getParamValue(deviceState.selectedDeviceId, 'MapboxPublicKey') || '')
			: ''
	);
	let currentDestination = $derived.by(() => {
		if (!deviceState.selectedDeviceId) return null;
		const destination = getParamValue(deviceState.selectedDeviceId, 'NavDestination');
		return destination &&
			typeof destination === 'object' &&
			Number.isFinite(Number(destination.latitude)) &&
			Number.isFinite(Number(destination.longitude)) &&
			(Number(destination.latitude) !== 0 || Number(destination.longitude) !== 0)
			? destination
			: null;
	});

	$effect(() => {
		const deviceId = deviceState.selectedDeviceId || '';
		const token = currentMapboxToken;
		if (deviceId !== tokenDevice || (!mapboxToken && token)) {
			mapboxToken = token;
			tokenDevice = deviceId;
		}
	});

	let hasMap = $derived(!!currentCountryName);

	let downloadProgress = $derived.by(() => {
		if (downloadProgressParam) {
			try {
				const prog =
					typeof downloadProgressParam === 'string'
						? JSON.parse(downloadProgressParam)
						: downloadProgressParam;
				if (prog.total_files > 0 && prog.downloaded_files < prog.total_files) {
					return `${prog.downloaded_files}/${prog.total_files}`;
				}
			} catch {
				return '';
			}
		}
		return '';
	});

	let isDownloading = $derived.by(() => {
		if (localDownloadingOverride) return true;

		const isCheckingUpdates =
			dbUpdatesCheck === '1' ||
			dbUpdatesCheck === true ||
			dbUpdatesCheck === 'true' ||
			dbUpdatesCheck === 1;

		const hasProgress = downloadProgress !== '' && downloadProgress !== undefined;

		return isCheckingUpdates || hasProgress;
	});

	async function fetchOsmParams(deviceId: string, token: string, silent: boolean = false) {
		if (!silent) loadingOsmParams = true;
		try {
			const controller = new AbortController();
			const res = await fetchSettingsAsync(deviceId, MAP_PARAMS, token, {
				maxPollTimeMs: 8000,
				signal: controller.signal
			});

			if (res.items) {
				const existing = deviceState.deviceSettings[deviceId] || [];
				const osmParamsSet = new Set(MAP_PARAMS);

				// Remove old versions of these params
				const filtered = existing.filter((i) => i.key && !osmParamsSet.has(i.key));
				// Add new ones
				deviceState.deviceSettings[deviceId] = [...filtered, ...res.items];

				// Persist to cache for SWR on next visit
				saveOsmCache(
					deviceId,
					res.items.filter((item) => item.key && OSM_PARAMS.includes(item.key))
				);
			}
		} catch (e) {
			console.error('Failed to fetch OSM params', e);
		} finally {
			if (!silent) loadingOsmParams = false;
		}
	}

	let osmFetchDone = $state<Record<string, boolean>>({});

	// Reset fetch guard when valuesStale is set (manual refresh or version change)
	$effect(() => {
		const did = deviceState.selectedDeviceId;
		if (did && deviceState.valuesStale[did]) {
			osmFetchDone[did] = false;
		}
	});

	$effect(() => {
		const deviceId = deviceState.selectedDeviceId;
		const isOnline = deviceId ? deviceState.onlineStatuses[deviceId] === 'online' : false;
		const downloading = isDownloading;
		if (
			deviceId &&
			logtoClient &&
			isOnline &&
			!downloading &&
			!untrack(() => osmFetchDone[deviceId])
		) {
			// Use silent fetch when we already have cached data to avoid spinner flash
			const hasCachedData = untrack(() =>
				deviceState.deviceSettings[deviceId]?.some((p: any) => p.key === 'OsmLocationName')
			);
			osmFetchDone[deviceId] = true;
			logtoClient.getIdToken().then((token) => {
				if (token) fetchOsmParams(deviceId, token, hasCachedData);
			});
		}
	});

	$effect(() => {
		let interval: ReturnType<typeof setInterval>;

		if (isDownloading && deviceState.selectedDeviceId) {
			const deviceId = deviceState.selectedDeviceId;
			interval = setInterval(() => {
				logtoClient?.getIdToken().then((token) => {
					if (token) {
						fetchOsmParams(deviceId, token, true).then(() => {
							if (localDownloadingOverride) {
								localDownloadingOverride = false;
							}
						});
					}
				});
			}, 3000);
		}

		return () => {
			if (interval) clearInterval(interval);
		};
	});

	let selectedCountry = $state<string>('');
	let selectedState = $state<string>('');

	onMount(async () => {
		await fetchCountries();
	});

	// Sync device values → local selections (read-only deps, write via untrack)
	$effect(() => {
		const country = currentCountryName;
		const state = currentStateName;
		const downloading = isDownloading;
		if (country && !untrack(() => selectedCountry) && !downloading) {
			selectedCountry = country;
		}
		if (state && !untrack(() => selectedState) && !downloading) {
			selectedState = state;
		}
	});

	// Fetch US states when country is US (separate effect to avoid loop)
	let fetchStatesRequested = $state(false);
	$effect(() => {
		if (selectedCountry === 'US' && states.length === 0 && !untrack(() => fetchStatesRequested)) {
			fetchStatesRequested = true;
			fetchStates().then(() => {
				// After states load, sync state selection if available
				const state = untrack(() => currentStateName);
				if (state && !untrack(() => selectedState)) {
					selectedState = state;
				}
			});
		}
	});

	async function fetchCountries() {
		loadingRegions = true;
		try {
			const res = await fetch(
				'https://raw.githubusercontent.com/pfeiferj/openpilot-mapd/main/nation_bounding_boxes.json'
			);
			const data = await res.json();
			countries = Object.entries(data)
				.map(([k, v]: [string, any]) => ({
					ref: k,
					display_name: v.display_name || v.full_name || k
				}))
				.sort((a, b) => a.display_name.localeCompare(b.display_name));
		} catch (e) {
			console.error('Failed to fetch countries', e);
			error = 'Failed to load region data.';
		} finally {
			loadingRegions = false;
		}
	}

	async function fetchStates() {
		loadingRegions = true;
		try {
			const res = await fetch(
				'https://raw.githubusercontent.com/pfeiferj/openpilot-mapd/main/us_states_bounding_boxes.json'
			);
			const data = await res.json();
			states = Object.entries(data)
				.map(([k, v]: [string, any]) => ({
					ref: k,
					display_name: v.display_name || v.full_name || k
				}))
				.sort((a, b) => a.display_name.localeCompare(b.display_name));
			states.unshift({ ref: 'All', display_name: 'All states (~6.0 GB)' });
		} catch (e) {
			console.error('Failed to fetch states', e);
		} finally {
			loadingRegions = false;
		}
	}

	async function handleSaveAndDownload() {
		if (!deviceState.selectedDeviceId || !logtoClient) return;
		const token = await logtoClient.getIdToken();
		if (!token) return;

		localDownloadingOverride = true;

		try {
			const countryObj = countries.find((c) => c.ref === selectedCountry);
			const stateObj = states.find((s) => s.ref === selectedState);

			const paramsToSet = [
				{ key: 'OsmLocationName', value: selectedCountry },
				{ key: 'OsmLocationTitle', value: countryObj?.display_name || selectedCountry },
				{ key: 'OsmLocal', value: '1' },
				{ key: 'OsmDbUpdatesCheck', value: '1' }
			];

			if (selectedCountry === 'US' && stateObj) {
				paramsToSet.push(
					{ key: 'OsmStateName', value: selectedState },
					{ key: 'OsmStateTitle', value: stateObj.display_name }
				);
			} else {
				paramsToSet.push({ key: 'OsmStateName', value: '' }, { key: 'OsmStateTitle', value: '' });
			}

			await setDeviceParams(deviceState.selectedDeviceId, paramsToSet, token);
			toast.success('Download started on device');
		} catch (e) {
			console.error('Failed to start download', e);
			toast.error('Failed to start download');
			localDownloadingOverride = false;
		}
	}

	async function handleCheckForUpdates() {
		if (!deviceState.selectedDeviceId || !logtoClient) return;
		const token = await logtoClient.getIdToken();
		if (!token) return;

		toast.info('Checking for updates...');
		localDownloadingOverride = true;

		try {
			await setDeviceParams(
				deviceState.selectedDeviceId,
				[{ key: 'OsmDbUpdatesCheck', value: '1' }],
				token
			);
			toast.success('Update initiated on device');
		} catch (e) {
			toast.error('Failed to check for updates');
			localDownloadingOverride = false;
		}
	}

	async function handleDeleteOfflineMaps() {
		if (!deviceState.selectedDeviceId || !logtoClient) return;
		const token = await logtoClient.getIdToken();
		if (!token) return;

		clearingCache = true;

		try {
			await setDeviceParams(
				deviceState.selectedDeviceId,
				[
					{
						key: 'Mapd_ClearCache',
						value: encodeParamValue({
							key: 'Mapd_ClearCache',
							value: '1',
							type: 'Bool'
						}),
						is_compressed: false
					}
				],
				token
			);
			toast.success('Offline maps deletion request sent to device');
		} catch (e) {
			console.error('Failed to delete offline maps', e);
			toast.error('Failed to delete offline maps');
		} finally {
			clearingCache = false;
			clearCacheModalOpen = false;
		}
	}

	async function handleSaveMapboxToken() {
		if (!deviceState.selectedDeviceId || !logtoClient) return;
		const value = mapboxToken.trim();
		if (!value.startsWith('pk.')) {
			toast.error('Mapbox Public Token must start with pk.');
			return;
		}
		const token = await logtoClient.getIdToken();
		if (!token) return;
		savingToken = true;
		try {
			await setDeviceParams(
				deviceState.selectedDeviceId,
				[
					{
						key: 'MapboxPublicKey',
						value: encodeParamValue({ key: 'MapboxPublicKey', value, type: 'String' }),
						is_compressed: false
					}
				],
				token
			);
			toast.success('Mapbox Public Token saved to device');
		} catch (e) {
			console.error('Failed to save Mapbox token', e);
			toast.error('Failed to save Mapbox Public Token');
		} finally {
			savingToken = false;
		}
	}

	async function searchDestination() {
		const query = destinationQuery.trim();
		const token = mapboxToken.trim() || currentMapboxToken;
		if (!query || !token.startsWith('pk.')) {
			toast.error('Save a valid Mapbox Public Token before searching');
			return;
		}
		searchingDestination = true;
		selectedDestination = null;
		try {
			const params = new URLSearchParams({
				q: query,
				access_token: token,
				limit: '5',
				language: navigator.language || 'en'
			});
			const response = await fetch(`https://api.mapbox.com/search/geocode/v6/forward?${params}`);
			if (!response.ok) throw new Error(`Mapbox search failed (${response.status})`);
			const data = await response.json();
			destinationResults = (data.features || []).map((feature: any) => ({
				id: feature.id,
				name: feature.properties?.name || feature.properties?.full_address || query,
				details: feature.properties?.full_address || feature.properties?.place_formatted || '',
				longitude: feature.geometry.coordinates[0],
				latitude: feature.geometry.coordinates[1]
			}));
			if (destinationResults.length === 0) toast.info('No destinations found');
		} catch (e) {
			console.error('Failed to search destination', e);
			toast.error('Destination search failed');
		} finally {
			searchingDestination = false;
		}
	}

	async function handleSetDestination() {
		if (!deviceState.selectedDeviceId || !selectedDestination || !logtoClient) return;
		const token = await logtoClient.getIdToken();
		if (!token) return;
		settingDestination = true;
		try {
			const result = await Athenav0Client.POST('/navigation/{deviceId}/set_destination', {
				params: { path: { deviceId: deviceState.selectedDeviceId } },
				body: {
					latitude: selectedDestination.latitude,
					longitude: selectedDestination.longitude,
					place_name: selectedDestination.name,
					place_details: selectedDestination.details
				},
				headers: { Authorization: `Bearer ${token}` }
			});
			if (!result.response.ok)
				throw new Error(`Set destination failed (${result.response.status})`);
			toast.success('Navigation destination sent to device');
			destinationResults = [];
			selectedDestination = null;
			destinationQuery = '';
			await fetchOsmParams(deviceState.selectedDeviceId, token, true);
		} catch (e) {
			console.error('Failed to set destination', e);
			toast.error('Failed to set navigation destination');
		} finally {
			settingDestination = false;
		}
	}

	async function handleCancelNavigation() {
		if (!deviceState.selectedDeviceId || !logtoClient) return;
		const token = await logtoClient.getIdToken();
		if (!token) return;
		cancellingNavigation = true;
		try {
			const result = await Athenav0Client.POST('/navigation/{deviceId}/set_destination', {
				params: { path: { deviceId: deviceState.selectedDeviceId } },
				body: { latitude: 0, longitude: 0 },
				headers: { Authorization: `Bearer ${token}` }
			});
			if (!result.response.ok)
				throw new Error(`Cancel navigation failed (${result.response.status})`);
			toast.success('Navigation cancelled');
			await fetchOsmParams(deviceState.selectedDeviceId, token, true);
		} catch (e) {
			console.error('Failed to cancel navigation', e);
			toast.error('Failed to cancel navigation');
		} finally {
			cancellingNavigation = false;
		}
	}

	function formatTimeAgo(timestamp: string | null) {
		if (!timestamp) return 'Never';
		try {
			// python time.time() is seconds, js Date needs ms
			const date = new Date(parseFloat(timestamp) * 1000);
			const now = new Date();
			const diffMs = now.getTime() - date.getTime();
			const diffSec = Math.round(diffMs / 1000);
			const diffMin = Math.round(diffSec / 60);
			const diffHour = Math.round(diffMin / 60);
			const diffDay = Math.round(diffHour / 24);

			if (diffSec < 60) return 'Just now';
			if (diffMin < 60) return `${diffMin} minute${diffMin !== 1 ? 's' : ''} ago`;
			if (diffHour < 24) return `${diffHour} hour${diffHour !== 1 ? 's' : ''} ago`;
			return `${diffDay} day${diffDay !== 1 ? 's' : ''} ago`;
		} catch {
			return 'Unknown';
		}
	}
</script>

<SettingsPageShell
	title="Maps"
	description="Manage offline OpenStreetMap data on your device"
	syncStatus={!loadingOsmParams ? sync.status : undefined}
	loading={loadingOsmParams}
	onRefresh={async () => {
		const did = deviceState.selectedDeviceId;
		if (!did || !logtoClient) return;
		// Master invalidation signal — also drives the valuesStale $effect so
		// the spinner shows "Refreshing..." instantly and consumers re-fetch.
		deviceState.invalidateAll(did);
		try {
			const token = await logtoClient.getIdToken();
			if (!token) return;
			await Promise.all([
				checkDeviceStatus(did, token, true, false),
				fetchOsmParams(did, token, false)
			]);
		} finally {
			// Clear stale so the title-bar sync indicator can transition to "synced"
			deviceState.valuesStale[did] = false;
		}
	}}
>
	{#if authState.loading}
		<DashboardSkeleton />
	{:else if !deviceState.selectedDeviceId}
		<div
			class="rounded-xl border border-[var(--sl-border)] bg-[var(--sl-bg-surface)] px-4 py-12 text-center"
		>
			<p class="text-[0.8125rem] font-[450] text-[var(--sl-text-3)]">
				Select a device to manage maps
			</p>
		</div>
	{:else if isOffline}
		{#await data.streamed.deviceResult then result}
			{@const devices = result.devices ?? []}
			{@const selectedDevice = devices?.find(
				(d: { device_id: string | null }) => d.device_id === deviceState.selectedDeviceId
			)}
			<div
				class="rounded-xl border border-[var(--sl-border)] bg-[var(--sl-bg-surface)] px-4 py-12 text-center"
			>
				<p class="text-[0.8125rem] font-medium text-[var(--sl-text-1)]">
					Device Offline{selectedDevice?.alias ? `: ${selectedDevice.alias}` : ''}
				</p>
				<p class="mt-1 text-[0.75rem] font-[450] text-[var(--sl-text-3)]">
					Your device needs to be online to manage maps.
				</p>
				<div class="mt-4 flex flex-col items-center gap-3">
					<button
						class="btn btn-sm btn-primary"
						onclick={async () => {
							if (deviceState.selectedDeviceId && logtoClient) {
								const token = await logtoClient.getIdToken();
								if (token) await checkDeviceStatus(deviceState.selectedDeviceId, token);
							}
						}}
					>
						Retry Connection
					</button>
					{#if devices && devices.length > 1}
						<a
							href="/dashboard/devices"
							class="text-[0.8125rem] text-[var(--sl-text-2)] underline decoration-[var(--sl-text-3)]/30 underline-offset-2 hover:text-[var(--sl-text-1)]"
						>
							Switch to another device
						</a>
					{/if}
				</div>
			</div>
		{/await}
	{:else}
		<div>
			<!-- ── Mapbox Navigation ─────────────────────────────── -->
			<div class="px-4">
				<p class="text-[0.9375rem] font-medium text-[var(--sl-text-1)]">Mapbox Navigation</p>
				<p class="mt-2 text-[0.8125rem] font-[450] text-[var(--sl-text-2)]">
					Configure routing and send a one-time destination to your device
				</p>
			</div>

			<div
				class="mt-3 overflow-hidden rounded-xl border border-[var(--sl-border)] bg-[var(--sl-bg-surface)]"
			>
				<div class="space-y-3 px-4 py-4">
					<label class="block">
						<span class="text-[0.8125rem] font-medium text-[var(--sl-text-1)]"
							>Mapbox Public Token</span
						>
						<input
							type="password"
							class="input-bordered input mt-2 w-full"
							placeholder="pk.ey..."
							autocomplete="off"
							bind:value={mapboxToken}
							disabled={savingToken}
						/>
					</label>
					<div class="flex justify-end">
						<button
							class="btn btn-sm btn-primary"
							onclick={handleSaveMapboxToken}
							disabled={savingToken || !mapboxToken.trim()}
						>
							{#if savingToken}<Loader2 size={14} class="animate-spin" />{/if}
							Save Token
						</button>
					</div>
				</div>

				<div class="border-t border-[var(--sl-border-muted)] px-4 py-4">
					{#if currentDestination}
						<div
							class="mb-4 flex items-start justify-between gap-4 rounded-lg bg-[var(--sl-bg-subtle)] p-3"
						>
							<div class="min-w-0">
								<p class="text-[0.8125rem] font-medium text-[var(--sl-text-1)]">
									Active destination
								</p>
								<p class="mt-1 truncate text-[0.75rem] text-[var(--sl-text-2)]">
									{currentDestination.place_name ||
										currentDestination.place_details ||
										`${currentDestination.latitude}, ${currentDestination.longitude}`}
								</p>
							</div>
							<button
								class="btn btn-outline btn-sm btn-error"
								onclick={handleCancelNavigation}
								disabled={cancellingNavigation}
							>
								{#if cancellingNavigation}<Loader2 size={14} class="animate-spin" />{:else}<X
										size={14}
									/>{/if}
								Cancel
							</button>
						</div>
					{/if}

					<div class="flex gap-2">
						<input
							type="search"
							class="input-bordered input min-w-0 flex-1"
							placeholder="Search an address or place"
							bind:value={destinationQuery}
							onkeydown={(event) => event.key === 'Enter' && searchDestination()}
						/>
						<button
							class="btn btn-primary"
							onclick={searchDestination}
							disabled={searchingDestination || !destinationQuery.trim()}
						>
							{#if searchingDestination}<Loader2 size={14} class="animate-spin" />{:else}<Navigation
									size={14}
								/>{/if}
							Search
						</button>
					</div>

					{#if destinationResults.length > 0}
						<div
							class="mt-3 divide-y divide-[var(--sl-border-muted)] overflow-hidden rounded-lg border border-[var(--sl-border-muted)]"
						>
							{#each destinationResults as destination}
								<button
									class="block w-full px-3 py-3 text-left transition-colors hover:bg-[var(--sl-bg-subtle)] {selectedDestination?.id ===
									destination.id
										? 'bg-[var(--sl-bg-subtle)]'
										: ''}"
									onclick={() => (selectedDestination = destination)}
								>
									<p class="text-[0.8125rem] font-medium text-[var(--sl-text-1)]">
										{destination.name}
									</p>
									<p class="mt-0.5 text-[0.75rem] text-[var(--sl-text-3)]">{destination.details}</p>
								</button>
							{/each}
						</div>
						<div class="mt-3 flex justify-end">
							<button
								class="btn btn-sm btn-primary"
								onclick={handleSetDestination}
								disabled={!selectedDestination || settingDestination}
							>
								{#if settingDestination}<Loader2 size={14} class="animate-spin" />{:else}<Navigation
										size={14}
									/>{/if}
								Start Navigation
							</button>
						</div>
					{/if}
				</div>
			</div>

			<!-- ── Current Map Section ──────────────────────────────── -->
			<div class="mt-12 px-4">
				<p class="text-[0.9375rem] font-medium text-[var(--sl-text-1)]">Current Map</p>
				<p class="mt-2 text-[0.8125rem] font-[450] text-[var(--sl-text-2)]">
					Offline map data downloaded on device
				</p>
			</div>

			<div
				class="mt-3 overflow-hidden rounded-xl border border-[var(--sl-border)] bg-[var(--sl-bg-surface)]"
			>
				{#if loadingOsmParams && !isDownloading && !hasMap}
					<div class="flex items-center gap-2.5 px-4 py-3.5">
						<span class="loading loading-xs loading-spinner text-[var(--sl-text-3)]"></span>
						<span class="text-[0.8125rem] font-[450] text-[var(--sl-text-2)]"
							>Loading map details...</span
						>
					</div>
				{:else if isCheckingStatus && !hasMap}
					<div class="flex items-center gap-2.5 px-4 py-3.5">
						<span class="loading loading-xs loading-spinner text-[var(--sl-text-3)]"></span>
						<span class="text-[0.8125rem] font-[450] text-[var(--sl-text-2)]"
							>Checking device status...</span
						>
					</div>
				{:else if hasMap || isDownloading}
					<div class="px-4 py-3.5">
						<div class="flex items-center justify-between">
							<div>
								{#if isDownloading && !currentCountryTitle}
									<p class="text-[0.8125rem] font-medium text-[var(--sl-text-1)]">
										Downloading map...
									</p>
								{:else}
									<p class="text-[0.8125rem] font-medium text-[var(--sl-text-1)]">
										{currentCountryTitle || currentCountryName || 'Unknown'}
										{#if currentStateTitle || currentStateName}
											— {currentStateTitle || currentStateName}
										{/if}
									</p>
								{/if}
								{#if isDownloading}
									<p class="mt-0.5 text-[0.75rem] font-[450] text-[var(--sl-text-3)]">
										{downloadProgress ? `Downloading ${downloadProgress}` : 'Processing...'}
									</p>
								{:else}
									<p class="mt-0.5 text-[0.75rem] font-[450] text-[var(--sl-text-3)]">
										Updated {formatTimeAgo(downloadedDateParam)}
									</p>
								{/if}
							</div>
							<div class="flex items-center gap-2">
								{#if isDownloading}
									<Loader2 size={14} class="animate-spin text-[var(--sl-text-3)]" />
								{:else}
									<button
										class="text-[0.75rem] font-[450] text-[var(--sl-text-2)] transition-colors hover:text-[var(--sl-text-1)]"
										onclick={handleCheckForUpdates}
									>
										Check for Updates
									</button>
								{/if}
							</div>
						</div>
					</div>
				{:else}
					<div class="px-4 py-8 text-center">
						<p class="text-[0.8125rem] font-[450] text-[var(--sl-text-3)]">
							No offline map downloaded on this device
						</p>
					</div>
				{/if}
				{#if true}
					<div class="flex items-center gap-3 border-t border-[var(--sl-border-muted)] px-4 py-2.5">
						<button
							class="text-[0.75rem] text-[var(--sl-text-2)] transition-all duration-100 hover:text-red-600 active:scale-[0.94] active:opacity-80 disabled:opacity-40 disabled:active:scale-100 dark:hover:text-red-400"
							onclick={() => (clearCacheModalOpen = true)}
							disabled={clearingCache}
						>
							Delete Offline Maps
						</button>
					</div>
				{/if}
			</div>

			<!-- ── Download Section: 48px from previous card ──────── -->
			<div class="mt-12 px-4">
				<p class="text-[0.9375rem] font-medium text-[var(--sl-text-1)]">Download Map</p>
				<p class="mt-2 text-[0.8125rem] font-[450] text-[var(--sl-text-2)]">
					Select a region to download for offline use
				</p>
			</div>

			<div class="mt-3 rounded-xl border border-[var(--sl-border)] bg-[var(--sl-bg-surface)]">
				<div class="space-y-4 px-4 py-4">
					<ComboBox
						label="Country"
						placeholder="Select a country"
						options={countries.map((c) => ({ value: c.ref, label: c.display_name }))}
						bind:value={selectedCountry}
						disabled={isDownloading || loadingRegions}
					/>

					{#if selectedCountry === 'US'}
						<ComboBox
							label="State"
							placeholder="Select a state"
							options={states.map((s) => ({ value: s.ref, label: s.display_name }))}
							bind:value={selectedState}
							disabled={isDownloading || loadingRegions}
						/>
					{/if}

					{#if selectedCountry === 'US' && !selectedState}
						<p class="text-[0.75rem] font-[450] text-[var(--sl-text-3)]">
							State selection is required for US maps
						</p>
					{/if}
				</div>

				<div class="border-t border-[var(--sl-border-muted)] px-4 py-3">
					<div class="flex items-center justify-between">
						<p class="text-[0.75rem] font-[450] text-[var(--sl-text-3)]">
							Map downloads can be large (up to several GB)
						</p>
						<button
							class="btn btn-sm btn-primary"
							disabled={!selectedCountry ||
								(selectedCountry === 'US' && !selectedState) ||
								isDownloading}
							onclick={handleSaveAndDownload}
						>
							{#if isDownloading}
								<Loader2 size={14} class="animate-spin" />
								Downloading...
							{:else}
								<Download size={14} />
								Download
							{/if}
						</button>
					</div>
				</div>
			</div>
		</div>
	{/if}
</SettingsPageShell>

<ConfirmationModal
	bind:open={clearCacheModalOpen}
	title="Delete Offline Maps"
	message="Are you sure you want to delete all offline maps on this device? This will clear the downloaded map data."
	confirmText="Delete Offline Maps"
	variant="danger"
	isProcessing={clearingCache}
	onConfirm={handleDeleteOfflineMaps}
/>
