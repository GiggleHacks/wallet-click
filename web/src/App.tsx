import { AnimatePresence } from 'motion/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import { AppMark, BookIcon, CoinIcon, DisplayIcon, HouseIcon, LogIcon, PlayIcon, ShieldIcon, WarnIcon } from './components/art';
import { JourneyDialog } from './components/JourneyDialog';
import { DisplayProperties } from './components/DisplayProperties';
import { Taskbar, type Balloon, type TaskItem } from './components/Taskbar';
import { DesktopBombs, TrayBomb, isBomb, useBombs, type Bomb, type Fused } from './components/TimeBomb';
import { TransferDialog } from './components/TransferDialog';
import { VersionTag } from './components/VersionTag';
import { DragBounds, ModalLayer, Window } from './components/Win98';
import { DEMO_ID, DEMO_TRANSFER, useDemo, type DemoKind } from './lib/demo';
import { trimAmount, usdt } from './lib/format';
import { getChoice, setChoice, usePref } from './lib/prefs';
import { applyThemeAttr, saveMode, savedMode, saveTheme, savedTheme, ThemeContext, useDark, type Mode, type Theme } from './lib/themes';
import { savedWallpaper, saveWallpaper, wallpaperById, wallpaperCss, type Wallpaper } from './lib/wallpapers';
import { setSoundTheme, sfx } from './lib/sound';
import { AddressBook } from './pages/AddressBook';
import { Addresses } from './pages/Addresses';
import { DemoPicker } from './pages/DemoPicker';
import { PrivacyDialog } from './pages/PrivacyDialog';
import { Home } from './pages/Home';
import { Lock } from './pages/Lock';
import { Logs } from './pages/Logs';
import { Receive } from './pages/Receive';
import { APP_VERSION } from './version';
import type { Coin, Destination, Meta, Order, Stage, Status, Transfer, TransferStage } from './types';

const POLL_MS = 2000;

/** Flashes the tab title until you come back to it (like a Win98 taskbar button asking for attention). */
function flashTitle(text: string): void {
  if (document.hasFocus()) return;
  let on = false;
  const iv = setInterval(() => {
    on = !on;
    document.title = on ? `💰 ${text}` : 'Wallet Click';
  }, 900);
  const stop = () => {
    clearInterval(iv);
    document.title = 'Wallet Click';
    window.removeEventListener('focus', stop);
  };
  window.addEventListener('focus', stop);
}
const IDLE: Stage[] = ['waiting', 'expired'];

function MessageBox({ title, text, onOk }: { title: string; text: string; onOk(): void }) {
  return (
    <ModalLayer>
      <Window title={title} onClose={onOk} className="win-msg" role="alertdialog">
        <div className="msg">
          <WarnIcon size={32} />
          <p>{text}</p>
        </div>
        <div className="btn-row is-center">
          <button type="button" className="btn98 is-default" onClick={onOk} autoFocus>
            OK
          </button>
        </div>
      </Window>
    </ModalLayer>
  );
}

type View = { name: 'home' } | { name: 'receive'; id: string };

const DELAYS = [4, 12, 24, 42];
const LIVE: TransferStage[] = ['received', 'swapping', 'holding', 'sending'];

interface DesktopProps {
  onDemo(): void;
  onDisplay(): void;
  onAddressBook(): void;
  onAddresses(): void;
  onLogs(): void;
  bombs: Bomb[];
  onBomb(t: Transfer): void;
}

function DesktopIcons({ onDemo, onDisplay, onAddressBook, onAddresses, onLogs, bombs, onBomb }: DesktopProps) {
  return (
    <nav className="desk-icons" aria-label="Desktop">
      <button type="button" className="desk-icon" onClick={onDemo}>
        <PlayIcon size={32} />
        <span>How it works</span>
      </button>
      <button type="button" className="desk-icon" onClick={onAddresses}>
        <HouseIcon size={32} />
        <span>My Addresses</span>
      </button>
      <button type="button" className="desk-icon" onClick={onAddressBook}>
        <BookIcon size={32} />
        <span>Address Book</span>
      </button>
      <button type="button" className="desk-icon" onClick={onDisplay}>
        <DisplayIcon size={32} />
        <span>Themes</span>
      </button>
      <button type="button" className="desk-icon" onClick={onLogs}>
        <LogIcon size={32} />
        <span>Logs</span>
      </button>
      <DesktopBombs bombs={bombs} onOpen={onBomb} />
    </nav>
  );
}

interface MainProps {
  onLocked(): void;
  theme: Theme;
  wallpaper: Wallpaper;
  mode: Mode;
  onLook(theme: Theme, wallpaper: Wallpaper, mode: Mode): void;
}

function Main({ onLocked, theme, wallpaper, mode, onLook }: MainProps) {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [view, setView] = useState<View>({ name: 'home' });
  const [dialog, setDialog] = useState<{ id: string; auto: boolean } | null>(null);
  const [creating, setCreating] = useState<Coin | null>(null);
  const [balloon, setBalloon] = useState<Balloon | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [display, setDisplay] = useState(false);
  const [book, setBook] = useState(false);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  /** The open transfer window; `auto` = money just arrived, play the whole flow. */
  const [journey, setJourney] = useState<{ id: string; auto: boolean } | null>(null);
  const [demoPicker, setDemoPicker] = useState(false);
  const [privacy, setPrivacy] = useState(false);
  const [myAddresses, setMyAddresses] = useState(false);
  const [logs, setLogs] = useState(false);
  const [offline, setOffline] = useState(false);
  const [destinations, setDestinations] = useState<Destination[]>([]);
  const [destinationId, setDestinationId] = useState(() => getChoice('destination') ?? 'coinbase');
  const pickDestination = (id: string) => {
    setDestinationId(id);
    setChoice('destination', id);
  };

  const stages = useRef(new Map<string, Stage>());
  const tStages = useRef(new Map<string, TransferStage>());
  const loaded = useRef(false);
  const dialogRef = useRef(dialog);
  dialogRef.current = dialog;
  const journeyRef = useRef(journey);
  journeyRef.current = journey;

  useEffect(() => {
    api
      .meta()
      .then((m) => {
        setMeta(m);
        // An old copy is still open (an installed home-screen app keeps its files): offer a reload.
        if (m.version && APP_VERSION !== 'dev' && m.version !== APP_VERSION) {
          setBalloon({ id: Date.now(), title: 'Update available', text: `Wallet Click v${m.version} is ready. Tap to reload.`, onClick: () => location.reload() });
        }
      })
      .catch(() => {});
    api
      .destinations()
      .then((d) => setDestinations(d.destinations))
      .catch(() => {});
  }, []);
  // A removed destination falls back to Coinbase.
  const destination = destinations.find((d) => d.id === destinationId)?.id ?? 'coinbase';

  const notify = (title: string, text: string, onClick?: () => void) => setBalloon({ id: Date.now(), title, text, onClick });

  /** Polls every order and transfer and reacts to stage changes, whichever screen is open. */
  const refresh = useCallback(async () => {
    const { orders: list, transfers: tList = [] } = await api.orders();
    for (const t of tList) {
      const prev = tStages.current.get(t.id);
      tStages.current.set(t.id, t.stage);
      if (!loaded.current || prev === t.stage) continue;
      const showing = journeyRef.current?.id === t.id;
      const open = () => setJourney({ id: t.id, auto: false });
      if ((prev === undefined || prev === 'waiting' || prev === 'expired') && LIVE.includes(t.stage)) {
        // Money arrived (at a permanent address, or a Privacy Enhanced address): ring and show its journey.
        demoRef.current?.stop();
        flashTitle(`Payment detected: ${trimAmount(t.received)} ${t.coin}`);
        // The transfer window plays the whole flow from the start (it rings itself); otherwise just ring.
        if (!showing && !dialogRef.current) setJourney({ id: t.id, auto: true });
        else sfx.ding();
      } else if (t.stage === 'done') {
        sfx.tada();
        if (!showing) notify(`USDT sent to ${t.destinationLabel}`, t.usdt ? `${usdt(t.usdt)} USDT from ${trimAmount(t.received)} ${t.coin}.` : 'Transfer finished.', open);
      } else if (t.stage === 'attention') {
        sfx.error();
        if (!showing) notify('A transfer needs you', t.attention ?? 'Click to see why.', open);
      } else if (t.stage === 'holding' && !showing) {
        notify('Holding in Monero', `${t.xmr ? `${trimAmount(t.xmr)} XMR` : 'The Monero'} waits about ${t.delayHours} h, then goes to ${t.destinationLabel} as USDT.`, open);
      }
    }
    setTransfers(tList);
    for (const o of list) {
      const prev = stages.current.get(o.id);
      stages.current.set(o.id, o.stage);
      if (!loaded.current || prev === o.stage) continue;
      const showing = dialogRef.current?.id === o.id;
      const open = () => {
        setView({ name: 'receive', id: o.id });
        setDialog({ id: o.id, auto: false });
      };
      if (IDLE.includes(prev ?? 'waiting') && !IDLE.includes(o.stage)) {
        // A payment landed: pop the transfer window and play the whole flow (it rings the bell).
        // A real payment always wins over the "How it works" demo.
        demoRef.current?.stop();
        flashTitle(`Payment detected: ${trimAmount(o.received)} ${o.coin}`);
        if (!showing) {
          setView({ name: 'receive', id: o.id });
          setDialog({ id: o.id, auto: true });
        }
      } else if (!showing && o.stage === 'done') {
        sfx.tada();
        notify(`USDT sent to ${o.payoutLabel ?? 'Coinbase'}`, o.usdt ? `${usdt(o.usdt)} USDT from ${trimAmount(o.received)} ${o.coin}.` : `${o.coinName} swap finished.`, open);
      } else if (!showing && o.stage === 'attention') {
        sfx.error();
        const flags = o.emergency?.flags ?? [];
        if (flags.includes('LIMIT') && flags.includes('LESS') && !flags.includes('MORE') && !o.autoRefundError) {
          notify('Payment below the minimum', `${trimAmount(o.received)} ${o.coin} can't be swapped. Sending it back to the sender.`, open);
        } else notify('A transfer needs you', `${o.coinName} payment ${o.id}: click to see why.`, open);
      } else if (!showing && o.stage === 'refunded') {
        notify(
          o.refundTx ? 'Payment sent back' : 'Refund requested',
          `${trimAmount(o.received)} ${o.coin} is going back to ${o.refundSource === 'manual' ? 'the address you entered' : 'the sender'}.`,
          open,
        );
      }
    }
    loaded.current = true;
    setOrders(list);
  }, []);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const loop = async () => {
      try {
        await refresh();
        setOffline(false);
      } catch {
        setOffline(true); // shown in the status bar; we keep trying
      }
      if (alive) timer = setTimeout(loop, POLL_MS);
    };
    void loop();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [refresh]);

  const realDialogOpen = () =>
    Boolean((dialogRef.current && dialogRef.current.id !== DEMO_ID) || (journeyRef.current && journeyRef.current.id !== DEMO_TRANSFER));
  const demo = useDemo(meta?.payout.address ?? '', {
    // Never cover a real transfer window with the demo.
    onOpen: (o) => !realDialogOpen() && setView({ name: 'receive', id: o.id }),
    onDetected: (o) => !realDialogOpen() && setDialog({ id: o.id, auto: true }),
    onJourney: (t) => !realDialogOpen() && setJourney({ id: t.id, auto: true }),
  });
  const demoRef = useRef(demo);
  demoRef.current = demo;
  const playDemo = (kind: DemoKind) => {
    setDemoPicker(false);
    setDialog(null);
    setJourney(null);
    setView({ name: 'home' });
    demo.start(kind);
  };
  const pickDemo = () => {
    sfx.open();
    setDemoPicker(true);
  };
  const stopDemo = demo.stop;

  const create = async (coin: Coin) => {
    if (creating) return;
    stopDemo();
    setCreating(coin);
    document.body.classList.add('busy');
    try {
      const o = await api.createOrder(coin, destination);
      stages.current.set(o.id, o.stage);
      setOrders((prev) => [o, ...prev.filter((x) => x.id !== o.id)]);
      setDialog(null);
      setView({ name: 'receive', id: o.id });
      sfx.open();
    } catch (e) {
      sfx.error();
      setMessage(e instanceof Error ? e.message : "Couldn't get an address");
    } finally {
      setCreating(null);
      document.body.classList.remove('busy');
    }
  };

  const updateOrder = (o: Order) => {
    stages.current.set(o.id, o.stage);
    setOrders((prev) => prev.map((x) => (x.id === o.id ? o : x)));
  };

  const openOrder = (o: Order) => {
    sfx.open();
    setView({ name: 'receive', id: o.id });
    setDialog(IDLE.includes(o.stage) ? null : { id: o.id, auto: false });
  };

  const lock = () => {
    api.logout().finally(onLocked);
  };

  const legs = transfers.flatMap((t) => [t.leg1, t.leg2].filter((o): o is Order => Boolean(o)));
  const findOrder = (id: string) => (id === DEMO_ID ? (demo.order ?? undefined) : (orders.find((o) => o.id === id) ?? legs.find((o) => o.id === id)));
  const journeyT = journey ? (journey.id === DEMO_TRANSFER ? (demo.transfer ?? undefined) : transfers.find((t) => t.id === journey.id)) : undefined;
  const isDemoJourney = journeyT?.id === DEMO_TRANSFER;
  const delays = meta?.privacy?.delays ?? DELAYS;
  const updateTransfer = (t: Transfer) => {
    tStages.current.set(t.id, t.stage);
    setTransfers((prev) => prev.map((x) => (x.id === t.id ? t : x)));
  };
  const openTransfer = (t: Transfer) => {
    sfx.open();
    if (t.leg1 && !t.routeId && t.leg1.stage === 'waiting') setView({ name: 'receive', id: t.leg1.id });
    else setJourney({ id: t.id, auto: false });
  };
  // Long Privacy waits tick away on the desktop as bombs (the demo's too, on its fast-forwarded clock).
  const lapse = demo.timeLapse;
  const fused: Fused[] = transfers.filter(isBomb).map((t) => ({ transfer: t, now: Date.now }));
  if (demo.transfer && isBomb(demo.transfer)) {
    fused.push({ transfer: demo.transfer, now: () => (lapse ? lapse.virtualStart + (Date.now() - lapse.realStart) * lapse.speed : Date.now()), fast: Boolean(lapse) });
  }
  const bombs = useBombs(fused, meta?.privacy?.testDelayMin ?? null);
  const openBomb = (t: Transfer) => {
    sfx.open();
    setJourney({ id: t.id, auto: false });
  };

  const current = view.name === 'receive' ? findOrder(view.id) : undefined;
  const dialogOrder = dialog ? findOrder(dialog.id) : undefined;
  const isDemo = current?.id === DEMO_ID;
  const closeDialog = useCallback(() => setDialog(null), []);
  const goHome = () => {
    setDialog(null);
    setView({ name: 'home' });
    if (demo.order || demo.transfer) {
      stopDemo();
      setJourney(null);
    }
  };
  const dismissBalloon = useCallback(() => setBalloon(null), []);

  const items: TaskItem[] = [
    { key: 'home', label: 'Wallet Click', icon: <AppMark />, active: view.name === 'home' && !dialogOrder, onClick: goHome },
  ];
  if (current) items.push({ key: 'recv', label: `Receive ${current.coinName}`, icon: <CoinIcon coin={current.coin} size={16} />, active: !dialogOrder, onClick: () => setDialog(null) });
  if (dialogOrder) items.push({ key: 'dlg', label: 'Swapping…', icon: <AppMark />, active: true, onClick: () => {} });
  if (journeyT) items.push({ key: 'journey', label: journeyT.privacy ? 'Privacy transfer' : 'Transfer', icon: journeyT.privacy ? <ShieldIcon size={16} /> : <AppMark />, active: true, onClick: () => {} });

  return (
    <>
      <main className="workspace">
        <AnimatePresence mode="wait">
          {current ? (
            <Receive
              key={`r-${current.id}`}
              order={current}
              demo={isDemo}
              offline={offline}
              creating={creating !== null}
              onNew={() => (isDemo ? playDemo(demo.kind ?? current.coin) : current.transferId ? setPrivacy(true) : void create(current.coin))}
              onBack={goHome}
              onShowProgress={() => (current.transferId ? setJourney({ id: current.transferId, auto: false }) : setDialog({ id: current.id, auto: false }))}
            />
          ) : (
            <Home
              key="home"
              meta={meta}
              orders={orders}
              transfers={transfers}
              onOpenTransfer={openTransfer}
              onPrivacy={() => setPrivacy(true)}
              onAddresses={() => setMyAddresses(true)}
              destinations={destinations}
              destinationId={destination}
              onDestination={pickDestination}
              onAddressBook={() => setBook(true)}
              creating={creating}
              offline={offline}
              pressing={demo.pressing}
              onCreate={(c) => void create(c)}
              onOpen={openOrder}
              onDemo={pickDemo}
            />
          )}
        </AnimatePresence>
      </main>
      <DesktopIcons
        onDemo={pickDemo}
        onDisplay={() => setDisplay(true)}
        onAddressBook={() => setBook(true)}
        onAddresses={() => setMyAddresses(true)}
        onLogs={() => (sfx.open(), setLogs(true))}
        bombs={bombs}
        onBomb={openBomb}
      />
      <AnimatePresence>
        {dialogOrder && <TransferDialog key={dialogOrder.id} order={dialogOrder} autoplay={dialog?.auto} onClose={closeDialog} onUpdate={updateOrder} />}
      </AnimatePresence>
      <AnimatePresence>{display && <DisplayProperties theme={theme} wallpaper={wallpaper} mode={mode} onApply={onLook} onClose={() => setDisplay(false)} />}</AnimatePresence>
      <AnimatePresence>{book && <AddressBook destinations={destinations} onChange={setDestinations} onClose={() => setBook(false)} />}</AnimatePresence>
      <AnimatePresence>
        {journeyT && (
          <JourneyDialog
            key={journeyT.id}
            transfer={journeyT}
            autoplay={journey?.auto}
            demo={isDemoJourney}
            timeLapse={isDemoJourney ? demo.timeLapse : null}
            delays={delays}
            onClose={() => setJourney(null)}
            onUpdate={updateTransfer}
            onOpenOrder={(o) => {
              setJourney(null);
              setView({ name: 'receive', id: o.id });
            }}
          />
        )}
      </AnimatePresence>
      <AnimatePresence>
        {privacy && (
          <PrivacyDialog
            delays={delays}
            destinations={destinations}
            destinationId={destination}
            unavailable={meta?.features?.monero === false}
            testDelayMin={meta?.privacy?.testDelayMin ?? null}
            onClose={() => setPrivacy(false)}
            onCreated={(t) => {
              tStages.current.set(t.id, t.stage);
              setTransfers((prev) => [t, ...prev.filter((x) => x.id !== t.id)]);
              setPrivacy(false);
              setDialog(null);
              if (t.leg1) setView({ name: 'receive', id: t.leg1.id });
            }}
          />
        )}
      </AnimatePresence>
      <AnimatePresence>{demoPicker && <DemoPicker onPick={playDemo} onClose={() => setDemoPicker(false)} />}</AnimatePresence>
      <AnimatePresence>
        {myAddresses && <Addresses delays={delays} destinations={destinations} seedBackupPending={meta?.features?.seedBackupPending} onClose={() => setMyAddresses(false)} />}
      </AnimatePresence>
      <AnimatePresence>{logs && <Logs onClose={() => setLogs(false)} />}</AnimatePresence>
      {message && <MessageBox title="Wallet Click" text={message} onOk={() => setMessage(null)} />}
      <Taskbar
        items={items}
        balloon={balloon}
        onDismissBalloon={dismissBalloon}
        onCreate={(c) => void create(c)}
        onDemo={pickDemo}
        onDisplay={() => setDisplay(true)}
        onAddressBook={() => setBook(true)}
        onPrivacy={() => setPrivacy(true)}
        onAddresses={() => setMyAddresses(true)}
        onLogs={() => setLogs(true)}
        onLock={lock}
        tray={<TrayBomb bombs={bombs} onOpen={openBomb} />}
      />
    </>
  );
}

/** Windows 95's start-up screen: the sky, the name and the sliding colour bar. Click to skip. */
function Splash95({ onDone }: { onDone(): void }) {
  useEffect(() => {
    const t = setTimeout(onDone, 2200);
    return () => clearTimeout(t);
  }, [onDone]);
  return (
    <div className="splash95" onClick={onDone} role="presentation" style={{ background: wallpaperById('clouds')?.css }}>
      <div className="splash95-logo">
        <AppMark size={64} />
        <span>
          Wallet <b>Click</b>
          <sup>95</sup>
        </span>
      </div>
      <div className="splash95-bar" />
    </div>
  );
}

export function App() {
  usePref('hideFigures'); // re-render the whole tree so every amount and address re-masks
  const desktop = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [theme, setTheme] = useState(savedTheme);
  const [wallpaper, setWallpaper] = useState(() => savedWallpaper(savedTheme().wallpaper));
  const [mode, setMode] = useState<Mode>(savedMode);
  const dark = useDark(mode);
  const [splash, setSplash] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    applyThemeAttr(theme, dark);
    setSoundTheme(theme.id);
  }, [theme, dark]);

  const changeLook = (t: Theme, w: Wallpaper, m: Mode = mode) => {
    setMode(m);
    saveMode(m);
    const newTheme = t.id !== theme.id;
    setTheme(t);
    saveTheme(t.id);
    setWallpaper(w);
    saveWallpaper(w.id);
    if (newTheme) {
      setSoundTheme(t.id);
      sfx.unlock(); // each theme announces itself with its own start-up sound
    }
  };
  const endSplash = useCallback(() => setSplash(false), []);

  useEffect(() => {
    api
      .status()
      .then(setStatus)
      .catch((e: Error) => setError(e.message));
    const onLocked = () => setStatus((s) => (s ? { ...s, authed: false } : s));
    window.addEventListener('wc:locked', onLocked);
    return () => window.removeEventListener('wc:locked', onLocked);
  }, []);

  return (
    <ThemeContext.Provider value={theme}>
      <div ref={desktop} className="desktop" data-wallpaper={wallpaper.id} style={{ background: wallpaperCss(wallpaper, dark) }}>
        <DragBounds.Provider value={desktop}>
          {!status ? (
            error && <MessageBox title="Wallet Click" text={error} onOk={() => location.reload()} />
          ) : !status.authed ? (
            <main className="workspace is-center">
              <Lock
                status={status}
                onUnlocked={() => {
                  setStatus({ ...status, authed: true });
                  if (theme.id === 'win95') setSplash(true);
                }}
              />
              <VersionTag className="lock-version" />
            </main>
          ) : (
            <Main onLocked={() => setStatus({ ...status, authed: false })} theme={theme} wallpaper={wallpaper} mode={mode} onLook={changeLook} />
          )}
          {splash && <Splash95 onDone={endSplash} />}
        </DragBounds.Provider>
      </div>
    </ThemeContext.Provider>
  );
}
