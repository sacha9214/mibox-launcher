package fr.sacha.tvhome;

import android.app.Activity;
import android.app.ActivityManager;
import android.content.BroadcastReceiver;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.ActivityInfo;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.RectF;
import android.graphics.Typeface;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.util.LruCache;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.ViewOutlineProvider;
import android.view.animation.DecelerateInterpolator;
import android.widget.FrameLayout;
import android.widget.HorizontalScrollView;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextClock;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Light, Apple TV–inspired home screen: "Pour toi" header with tabs, a row of
 * featured Netflix France titles (via JustWatch), and a frosted dock of apps.
 */
public class HomeActivity extends Activity {

    // Palette, set by applyTheme() before the screen is built (light or dark).
    private static int INK, MUTED, ON_INK, SURFACE, PLACEHOLDER, GLASS, GLASS_EDGE, BG_TOP, BG, BG_BOTTOM;
    private static boolean focusThemeButton;

    private static void applyTheme(boolean dark) {
        INK = dark ? 0xFFF2F3F5 : 0xFF111114;
        MUTED = dark ? 0xFF8E9299 : 0xFF8A8D93;
        ON_INK = dark ? 0xFF111114 : Color.WHITE;
        SURFACE = dark ? 0xFF24262C : Color.WHITE;
        PLACEHOLDER = dark ? 0xFF2A2C33 : 0xFFD5D8DD;
        GLASS = dark ? 0xB31C1E23 : 0xB3FFFFFF;
        GLASS_EDGE = dark ? 0x26FFFFFF : 0xFFFFFFFF;
        BG_TOP = dark ? 0xFF17181C : 0xFFF6F7F9;
        BG = dark ? 0xFF0F1013 : 0xFFECEEF1;
        BG_BOTTOM = dark ? 0xFF08090B : 0xFFE2E5EA;
    }

    private boolean isDark() {
        return getSharedPreferences("tvhome", MODE_PRIVATE).getBoolean("dark", false);
    }

    private void toggleTheme() {
        getSharedPreferences("tvhome", MODE_PRIVATE).edit().putBoolean("dark", !isDark()).apply();
        focusThemeButton = true;
        recreate();
    }

    // Apps shown first in the dock, in this order. Everything else follows alphabetically.
    private static final List<String> PREFERRED = Arrays.asList(
            "net.oqee.androidtv.store", // Free TV (Oqee)
            "com.netflix.ninja",
            "com.google.android.youtube.tv",
            "com.amazon.amazonvideo.livingroom",
            "fr.francetv.pluzz",
            "tv.arte.plus7",
            "com.plexapp.android",
            "org.videolan.vlc",
            "com.android.vending");

    // What's popular on Netflix France, via JustWatch (no key needed).
    private static final String JW_API = "https://apis.justwatch.com/graphql";
    private static final String JW_IMG = "https://images.justwatch.com";
    private static final String JW_QUERY = "query($f:TitleFilter){popularTitles(country:FR,first:15,filter:$f)"
            + "{edges{node{objectType content(country:FR,language:\"fr\"){title posterUrl"
            + " backdrops{backdropUrl} genres{shortName} originalReleaseYear}"
            + " offers(country:FR,platform:WEB){package{clearName} standardWebURL}}}}}";
    private static final Map<String, String> GENRES = new HashMap<>();
    static {
        String[] g = {"act", "Action", "ani", "Animation", "cmy", "Comédie", "crm", "Crime",
                "doc", "Documentaire", "drm", "Drame", "fnt", "Fantastique", "hst", "Histoire",
                "hrr", "Horreur", "fml", "Famille", "msc", "Musique", "trl", "Thriller",
                "rma", "Romance", "scf", "Science-fiction", "spt", "Sport", "war", "Guerre",
                "wsn", "Western", "rly", "Téléréalité", "eur", "Européen"};
        for (int i = 0; i < g.length; i += 2) GENRES.put(g[i], g[i + 1]);
    }

    private final Handler ui = new Handler(Looper.getMainLooper());
    private final ExecutorService io = Executors.newFixedThreadPool(3);
    private final LruCache<String, Bitmap> images = new LruCache<String, Bitmap>(24 * 1024 * 1024) {
        @Override protected int sizeOf(String k, Bitmap b) { return b.getByteCount(); }
    };

    // Tabs, each a JustWatch filter on Netflix France (on top of packages=nfx).
    private static final String[] TABS = {"Explorer", "Films", "Séries", "Comédie", "Animé"};
    private static final String[] TAB_FILTERS = {
            "{}",
            "{\"objectTypes\":[\"MOVIE\"]}",
            "{\"objectTypes\":[\"SHOW\"]}",
            "{\"genres\":[\"cmy\"],\"productionCountries\":[\"FR\"]}", // French comedy
            "{\"genres\":[\"ani\"],\"productionCountries\":[\"JP\"]}"}; // Japanese animation
    private static final String[] TAB_CACHE = {
            "nf_all.json", "nf_movies.json", "nf_series.json", "nf_comedy_fr.json", "nf_anime.json"};
    private Map<String, List<Item>> lists = new HashMap<>();
    private String tab = "Explorer";
    private static final long REFRESH_MS = 6 * 60 * 60 * 1000L;
    private long lastFetch;
    private boolean shelfStale;

    private LinearLayout tabs;
    private LinearLayout shelf;
    private HorizontalScrollView shelfScroll;
    private LinearLayout dock;
    private HorizontalScrollView dockScroll;
    private TextView status;
    private View lastFocused;

    private final BroadcastReceiver packagesChanged = new BroadcastReceiver() {
        @Override public void onReceive(Context c, Intent i) { buildDock(); }
    };

    private static class Item {
        String title, subtitle, poster, wide, netflixUrl;
    }

    private static class App {
        String label, pkg;
        Intent launch;
        Drawable banner, icon;
    }

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        saveSideMargin(getIntent());
        applyTheme(isDark());

        FrameLayout root = new FrameLayout(this);
        root.setBackground(new GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM,
                new int[] {BG_TOP, BG, BG_BOTTOM}));

        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        col.setClipChildren(false);
        // Wide margins: the TV crops the picture edges (overscan).
        int side = getSharedPreferences("tvhome", MODE_PRIVATE).getInt("side_margin", 16);
        col.setPadding(dp(side), dp(30), dp(side), dp(24));
        root.addView(col, new FrameLayout.LayoutParams(-1, -1));

        tabs = new LinearLayout(this);
        tabs.setOrientation(LinearLayout.HORIZONTAL);
        for (String t : TABS) tabs.addView(makeTab(t));
        col.addView(buildHeader(), new LinearLayout.LayoutParams(-1, -2));

        shelfScroll = new HorizontalScrollView(this);
        shelfScroll.setHorizontalScrollBarEnabled(false);
        shelfScroll.setClipChildren(false);
        shelfScroll.setClipToPadding(false);
        shelfScroll.setPadding(dp(4), dp(14), dp(4), 0);
        shelf = new LinearLayout(this);
        shelf.setOrientation(LinearLayout.HORIZONTAL);
        shelf.setClipChildren(false);
        shelfScroll.addView(shelf);
        LinearLayout.LayoutParams slp = new LinearLayout.LayoutParams(-1, 0, 1f);
        slp.leftMargin = -dp(4);
        col.addView(shelfScroll, slp);

        // Frosted dock.
        FrameLayout dockBox = new FrameLayout(this);
        GradientDrawable glass = new GradientDrawable();
        glass.setCornerRadius(dp(22));
        glass.setColor(GLASS);
        glass.setStroke(dp(1), GLASS_EDGE);
        dockBox.setBackground(glass);
        dockBox.setElevation(dp(6));
        // Tiles scrolled past the edge are cut by the rounded glass, never drawn outside it.
        dockBox.setOutlineProvider(ViewOutlineProvider.BACKGROUND);
        dockBox.setClipToOutline(true);
        dockScroll = new HorizontalScrollView(this);
        // When scrolling to the focused tile, keep it this far from the band's edges.
        dockScroll.setHorizontalFadingEdgeEnabled(true);
        dockScroll.setFadingEdgeLength(dp(22));
        dockScroll.setHorizontalScrollBarEnabled(false);
        dockScroll.setClipChildren(false);
        dockScroll.setClipToPadding(false);
        dockScroll.setPadding(0, dp(11), 0, dp(11));
        dock = new LinearLayout(this);
        dock.setOrientation(LinearLayout.HORIZONTAL);
        dock.setClipChildren(false);
        // Room at both ends so the enlarged first/last tile stays clear of the band edge.
        dock.setPadding(dp(22), 0, dp(22), 0);
        dock.setClipToPadding(false);
        dockScroll.addView(dock);
        dockBox.addView(dockScroll, new FrameLayout.LayoutParams(-1, -2));
        col.addView(dockBox, new LinearLayout.LayoutParams(-1, -2));

        setContentView(root);
        buildDock();
        selectTab("Explorer");

        IntentFilter f = new IntentFilter();
        f.addAction(Intent.ACTION_PACKAGE_ADDED);
        f.addAction(Intent.ACTION_PACKAGE_REMOVED);
        f.addAction(Intent.ACTION_PACKAGE_CHANGED);
        f.addDataScheme("package");
        registerReceiver(packagesChanged, f);
    }

    @Override
    protected void onDestroy() {
        unregisterReceiver(packagesChanged);
        io.shutdownNow();
        super.onDestroy();
    }

    @Override
    protected void onResume() {
        super.onResume();
        updateStatus();
        ui.removeCallbacks(pricesTick);
        ui.post(pricesTick);
        // The launcher stays alive for days, so refresh the Netflix list when it gets old.
        if (System.currentTimeMillis() - lastFetch > REFRESH_MS) loadFeeds();
        else if (shelfStale && !shelf.hasFocus()) buildShelf();
        if (lastFocused != null && lastFocused.isAttachedToWindow()) lastFocused.requestFocus();
    }

    /**
     * Each TV crops its edges differently (overscan), so the side margin is per box, set with:
     *   adb shell am start -n fr.sacha.tvhome/.HomeActivity --ei side_margin 32
     */
    private boolean saveSideMargin(Intent i) {
        if (i == null || !i.hasExtra("side_margin")) return false;
        getSharedPreferences("tvhome", MODE_PRIVATE).edit()
                .putInt("side_margin", i.getIntExtra("side_margin", 16)).apply();
        return true;
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (saveSideMargin(intent)) recreate();
    }

    // Home is the bottom of the stack: Back does nothing here.
    @Override
    public void onBackPressed() { }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_HOME) return true;
        return super.onKeyDown(keyCode, event);
    }

    // ---- Header ------------------------------------------------------------

    private View buildHeader() {
        FrameLayout h = new FrameLayout(this);
        h.setClipChildren(false);
        h.setClipToPadding(false);

        // Tabs sit on the same line as the clock and buttons.
        FrameLayout.LayoutParams tlp = new FrameLayout.LayoutParams(-2, dp(30), Gravity.START | Gravity.TOP);
        // No negative margin: the focused pill would be cut by the screen padding.
        tabs.setGravity(Gravity.CENTER_VERTICAL);
        h.addView(tabs, tlp);

        LinearLayout buttons = new LinearLayout(this);
        buttons.setOrientation(LinearLayout.HORIZONTAL);
        TextClock clock = new TextClock(this);
        clock.setFormat24Hour("HH:mm");
        clock.setFormat12Hour("HH:mm");
        clock.setTextColor(INK);
        clock.setTextSize(15);
        clock.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        LinearLayout.LayoutParams clp = new LinearLayout.LayoutParams(-2, dp(30));
        clock.setGravity(Gravity.CENTER_VERTICAL);
        clp.rightMargin = dp(12);
        buttons.addView(clock, clp);
        // Moon in light mode (switch to dark), sun in dark mode (switch to light).
        View theme = roundButton(new GlyphView(this, isDark() ? GlyphView.SUN : GlyphView.MOON), this::toggleTheme);
        buttons.addView(theme);
        buttons.addView(roundButton(new GlyphView(this, GlyphView.WIFI), new Intent(Settings.ACTION_WIFI_SETTINGS)));
        buttons.addView(roundButton(new GlyphView(this, GlyphView.GEAR), new Intent(Settings.ACTION_SETTINGS)));
        if (focusThemeButton) {
            focusThemeButton = false;
            theme.post(theme::requestFocus);
            lastFocused = theme;
        }
        buttons.setGravity(Gravity.END);
        h.addView(buttons, new FrameLayout.LayoutParams(-1, -2, Gravity.END | Gravity.TOP));

        status = new TextView(this);
        status.setTextColor(MUTED);
        status.setTextSize(9);
        FrameLayout.LayoutParams stp = new FrameLayout.LayoutParams(-2, -2, Gravity.END | Gravity.TOP);
        stp.topMargin = dp(38);
        h.addView(status, stp);
        return h;
    }

    private View roundButton(View glyph, final Intent target) {
        return roundButton(glyph, () -> safeStart(target.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)));
    }

    private View roundButton(View glyph, final Runnable onClick) {
        FrameLayout b = new FrameLayout(this);
        GradientDrawable bg = new GradientDrawable();
        bg.setShape(GradientDrawable.OVAL);
        bg.setColor(SURFACE);
        b.setBackground(bg);
        b.setElevation(dp(1));
        b.setFocusable(true);
        b.addView(glyph, new FrameLayout.LayoutParams(dp(14), dp(14), Gravity.CENTER));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(dp(30), dp(30));
        lp.leftMargin = dp(8);
        b.setLayoutParams(lp);
        b.setOnFocusChangeListener((v, f) -> {
            bg.setColor(f ? INK : SURFACE);
            ((GlyphView) glyph).setColor(f ? ON_INK : INK);
            v.animate().scaleX(f ? 1.15f : 1f).scaleY(f ? 1.15f : 1f).setDuration(140).start();
        });
        b.setOnClickListener(v -> onClick.run());
        return b;
    }

    private void updateStatus() {
        ActivityManager am = (ActivityManager) getSystemService(ACTIVITY_SERVICE);
        ActivityManager.MemoryInfo mi = new ActivityManager.MemoryInfo();
        am.getMemoryInfo(mi);
        long used = mi.totalMem > 0 ? Math.round(100.0 * (mi.totalMem - mi.availMem) / mi.totalMem) : 0;
        String ram = "RAM " + used + " %";
        String quotes = (stock.isEmpty() ? "" : stock + "   ") + prices;
        status.setText(quotes.isEmpty() ? ram : quotes + "   ·   " + ram);
    }

    // EssilorLuxottica (Euronext Paris ticker EL), in euros, from Yahoo Finance.
    private static final String STOCK_URL =
            "https://query1.finance.yahoo.com/v8/finance/chart/EL.PA?range=1d&interval=1d";
    private String stock = "";

    // Crypto prices under the header buttons, refreshed every 5 minutes while Home is visible.
    private static final String PRICES_URL =
            "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana&vs_currencies=usd";
    private static final long PRICES_MS = 5 * 60 * 1000L;
    private String prices = "";
    private final Runnable pricesTick = new Runnable() {
        @Override public void run() {
            io.execute(() -> {
                try {
                    JSONObject j = new JSONObject(new String(download(PRICES_URL), StandardCharsets.UTF_8));
                    final String text = "BTC " + usd(j.getJSONObject("bitcoin").getDouble("usd"))
                            + "   ETH " + usd(j.getJSONObject("ethereum").getDouble("usd"))
                            + "   SOL " + usd(j.getJSONObject("solana").getDouble("usd"));
                    ui.post(() -> {
                        prices = text;
                        updateStatus();
                    });
                } catch (Exception ignored) { }
                try {
                    JSONObject meta = new JSONObject(new String(download(STOCK_URL), StandardCharsets.UTF_8))
                            .getJSONObject("chart").getJSONArray("result").getJSONObject(0).getJSONObject("meta");
                    final String text = "EL " + usd(meta.getDouble("regularMarketPrice"));
                    ui.post(() -> {
                        stock = text;
                        updateStatus();
                    });
                } catch (Exception ignored) { }
            });
            ui.postDelayed(this, PRICES_MS);
        }
    };

    /** 72585 → "72,6k", 2134.27 → "2 134", 92.88 → "92,88" (US dollars, no symbol). */
    private static String usd(double v) {
        java.util.Locale fr = java.util.Locale.FRANCE;
        if (v >= 10000) return String.format(fr, "%.1fk", v / 1000);
        if (v >= 1000) return String.format(fr, "%,.0f", v);
        return String.format(fr, "%.2f", v);
    }

    @Override
    protected void onPause() {
        ui.removeCallbacks(pricesTick);
        super.onPause();
    }

    private TextView makeTab(final String name) {
        final TextView t = new TextView(this);
        t.setText(name);
        t.setTextSize(13);
        t.setPadding(dp(10), dp(4), dp(10), dp(4));
        t.setFocusable(true);
        t.setId(View.generateViewId());
        t.setTag(name);
        t.setOnFocusChangeListener((v, f) -> {
            if (f) selectTab(name);
            styleTab(t, f);
        });
        t.setOnClickListener(v -> selectTab(name));
        return t;
    }

    private void styleTab(TextView t, boolean focused) {
        boolean selected = t.getTag().equals(tab);
        GradientDrawable pill = new GradientDrawable();
        pill.setCornerRadius(dp(14));
        pill.setColor(focused ? INK : Color.TRANSPARENT);
        t.setBackground(pill);
        t.setTextColor(focused ? ON_INK : selected ? INK : MUTED);
        t.setTypeface(Typeface.create("sans-serif-medium", selected ? Typeface.BOLD : Typeface.NORMAL));
    }

    private void selectTab(String name) {
        boolean changed = !name.equals(tab) || shelf.getChildCount() == 0;
        tab = name;
        for (int i = 0; i < tabs.getChildCount(); i++) {
            TextView t = (TextView) tabs.getChildAt(i);
            styleTab(t, t.hasFocus());
        }
        if (changed) buildShelf();
    }

    // ---- Featured shelf ----------------------------------------------------

    private List<Item> currentItems() {
        List<Item> l = lists.get(tab);
        return l != null ? l : new ArrayList<>();
    }

    private static List<String> titles(List<Item> items) {
        List<String> t = new ArrayList<>();
        for (Item it : items) t.add(it.title);
        return t;
    }

    private void buildShelf() {
        shelfStale = false;
        shelf.removeAllViews();
        shelfScroll.scrollTo(0, 0);
        List<Item> items = currentItems();
        int cardH = dp(250);
        if (items.isEmpty()) {
            TextView empty = new TextView(this);
            empty.setText("Chargement des films et séries…");
            empty.setTextColor(MUTED);
            empty.setTextSize(13);
            shelf.addView(empty, new LinearLayout.LayoutParams(-2, cardH));
            empty.setGravity(Gravity.CENTER_VERTICAL);
            return;
        }
        for (int i = 0; i < items.size(); i++) {
            Item it = items.get(i);
            boolean hero = i == 0;
            int w = hero ? cardH * 16 / 7 + dp(24) : cardH * 2 / 3 + dp(8);
            View card = makeCard(it, w, cardH, hero);
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(w, -2);
            if (i > 0) lp.leftMargin = dp(24);
            shelf.addView(card, lp);
            if (i == 0) lockEnd(((ViewGroup) card).getChildAt(0), true);
            if (i == items.size() - 1) lockEnd(((ViewGroup) card).getChildAt(0), false);
        }
    }

    private View makeCard(final Item it, int w, int h, boolean hero) {
        LinearLayout cell = new LinearLayout(this);
        cell.setOrientation(LinearLayout.VERTICAL);
        cell.setClipChildren(false);

        FrameLayout frame = new FrameLayout(this);
        GradientDrawable shape = new GradientDrawable();
        shape.setCornerRadius(dp(12));
        shape.setColor(PLACEHOLDER);
        frame.setBackground(shape);
        frame.setOutlineProvider(ViewOutlineProvider.BACKGROUND);
        frame.setClipToOutline(true);
        frame.setElevation(dp(2));
        frame.setFocusable(true);
        // Going up always lands on the active tab, not whichever tab happens to be closest.
        frame.setNextFocusUpId(tabs.findViewWithTag(tab).getId());
        ImageView img = new ImageView(this);
        img.setScaleType(ImageView.ScaleType.CENTER_CROP);
        frame.addView(img, new FrameLayout.LayoutParams(-1, -1));
        loadImage(hero ? it.wide : it.poster, img);
        cell.addView(frame, new LinearLayout.LayoutParams(w, h));

        TextView title = new TextView(this);
        title.setText(it.title);
        title.setTextColor(INK);
        title.setTextSize(12);
        title.setSingleLine(true);
        title.setEllipsize(android.text.TextUtils.TruncateAt.END);
        LinearLayout.LayoutParams tp = new LinearLayout.LayoutParams(w, -2);
        tp.topMargin = dp(8);
        cell.addView(title, tp);
        if (hero && it.subtitle != null) {
            TextView sub = new TextView(this);
            sub.setText(it.subtitle);
            sub.setTextColor(MUTED);
            sub.setTextSize(9);
            sub.setSingleLine(true);
            cell.addView(sub, new LinearLayout.LayoutParams(w, -2));
        }

        // Wide cards grow less so their edges stay clear of the neighbours.
        final float grow = hero ? 1.02f : 1.06f;
        // The first card sits on the screen margin: grow it rightwards so it never leaves the screen.
        if (hero) frame.setPivotX(0);
        frame.setOnFocusChangeListener((v, f) -> {
            v.animate().scaleX(f ? grow : 1f).scaleY(f ? grow : 1f).translationZ(f ? dp(14) : 0)
                    .setDuration(170).setInterpolator(new DecelerateInterpolator()).start();
            if (f) lastFocused = v;
            // The row nudges itself a few pixels when the first card is focused, cutting its left
            // edge and title; snap it back to the start.
            if (f && hero) shelfScroll.post(() -> shelfScroll.smoothScrollTo(0, 0));
        });
        // Opens the title in Netflix; falls back to its trailer on YouTube.
        frame.setOnClickListener(v -> {
            if (it.netflixUrl != null) {
                // The TV app only honours a deep link when started fresh on its main activity
                // with source=30; otherwise it resumes wherever it was.
                Intent nf = new Intent(Intent.ACTION_VIEW, Uri.parse(it.netflixUrl))
                        .setClassName("com.netflix.ninja", "com.netflix.ninja.MainActivity")
                        .putExtra("source", "30")
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
                if (safeStart(nf)) return;
            }
            Uri u = Uri.parse("https://www.youtube.com/results?search_query="
                    + Uri.encode(it.title + " bande annonce"));
            Intent yt = new Intent(Intent.ACTION_VIEW, u).setPackage("com.google.android.youtube.tv")
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            if (!safeStart(yt)) safeStart(new Intent(Intent.ACTION_VIEW, u).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        });
        return cell;
    }

    private void loadFeeds() {
        lastFetch = System.currentTimeMillis();
        if (lists.isEmpty()) io.execute(() -> {
            // Show the last saved lists immediately; the network answer replaces them below.
            final Map<String, List<Item>> cached = new HashMap<>();
            for (int i = 0; i < TABS.length; i++) cached.put(TABS[i], parseFeed(readCache(TAB_CACHE[i])));
            ui.post(() -> {
                if (!lists.isEmpty() || cached.get(TABS[0]).isEmpty()) return;
                lists = cached;
                if (!shelf.hasFocus()) buildShelf();
            });
        });
        io.execute(() -> {
            final Map<String, List<Item>> fresh = new HashMap<>();
            boolean any = false;
            for (int i = 0; i < TABS.length; i++) {
                List<Item> l = parseFeed(fetchCached(jwBody(TAB_FILTERS[i]), TAB_CACHE[i]));
                fresh.put(TABS[i], l);
                any |= !l.isEmpty();
            }
            final boolean gotSome = any;
            ui.post(() -> {
                if (!gotSome) {
                    lastFetch = 0; // Offline: try again next time Home is shown.
                    return;
                }
                boolean changed = false;
                for (String t : TABS) {
                    List<Item> old = lists.get(t);
                    changed |= old == null || !titles(fresh.get(t)).equals(titles(old));
                }
                lists = fresh;
                if (!changed) return;
                // Don't pull the row out from under someone browsing it.
                if (shelf.hasFocus()) shelfStale = true;
                else buildShelf();
            });
        });
    }

    /** GraphQL request body for popular Netflix FR titles matching an extra filter. */
    private static String jwBody(String extraFilter) {
        try {
            JSONObject filter = new JSONObject(extraFilter).put("packages", new JSONArray().put("nfx"));
            return new JSONObject().put("query", JW_QUERY)
                    .put("variables", new JSONObject().put("f", filter)).toString();
        } catch (Exception e) {
            return "{}";
        }
    }

    /** Queries JustWatch, falling back to the last saved answer when offline. */
    private String fetchCached(String body, String name) {
        File f = new File(getCacheDir(), name);
        try {
            String answer = new String(post(JW_API, body), StandardCharsets.UTF_8);
            new JSONObject(answer).getJSONObject("data");
            body = answer;
            try (FileOutputStream out = new FileOutputStream(f)) {
                out.write(body.getBytes(StandardCharsets.UTF_8));
            }
            return body;
        } catch (Exception e) {
            return readCache(name);
        }
    }

    private String readCache(String name) {
        try (FileInputStream in = new FileInputStream(new File(getCacheDir(), name))) {
            return new String(readAll(in), StandardCharsets.UTF_8);
        } catch (Exception ignored) {
            return null;
        }
    }

    private static List<Item> parseFeed(String json) {
        List<Item> out = new ArrayList<>();
        if (json == null) return out;
        try {
            JSONArray edges = new JSONObject(json).getJSONObject("data")
                    .getJSONObject("popularTitles").getJSONArray("edges");
            for (int i = 0; i < edges.length(); i++) {
                JSONObject node = edges.getJSONObject(i).getJSONObject("node");
                JSONObject c = node.getJSONObject("content");
                Item it = new Item();
                it.title = c.getString("title");
                String poster = c.optString("posterUrl", "");
                if (poster.isEmpty()) continue;
                it.poster = JW_IMG + poster.replace("{profile}", "s332").replace("{format}", "jpg");
                JSONArray bd = c.optJSONArray("backdrops");
                it.wide = bd != null && bd.length() > 0
                        ? JW_IMG + bd.getJSONObject(0).getString("backdropUrl")
                                .replace("{profile}", "s1440").replace("{format}", "jpg")
                        : it.poster;

                StringBuilder sub = new StringBuilder(node.optString("objectType").equals("SHOW") ? "Série" : "Film");
                JSONArray gs = c.optJSONArray("genres");
                for (int g = 0; gs != null && g < Math.min(2, gs.length()); g++) {
                    String name = GENRES.get(gs.getJSONObject(g).optString("shortName"));
                    if (name != null) sub.append(" · ").append(name);
                }
                int year = c.optInt("originalReleaseYear");
                if (year > 0) sub.append(" · ").append(year);
                sub.append(" · Netflix");
                it.subtitle = sub.toString();

                JSONArray offers = node.optJSONArray("offers");
                for (int o = 0; offers != null && o < offers.length(); o++) {
                    String url = offers.getJSONObject(o).optString("standardWebURL");
                    if (url.contains("netflix.com/title/")) {
                        it.netflixUrl = url;
                        break;
                    }
                }
                out.add(it);
            }
        } catch (Exception ignored) { }
        return out;
    }

    private void loadImage(final String url, final ImageView into) {
        if (url == null) return;
        into.setTag(url);
        Bitmap cached = images.get(url);
        if (cached != null) {
            into.setImageBitmap(cached);
            return;
        }
        io.execute(() -> {
            Bitmap b = null;
            File f = new File(getCacheDir(), "img_" + Integer.toHexString(url.hashCode()));
            try {
                byte[] data;
                if (f.exists()) {
                    try (FileInputStream in = new FileInputStream(f)) { data = readAll(in); }
                } else {
                    data = download(url);
                    try (FileOutputStream out = new FileOutputStream(f)) { out.write(data); }
                }
                b = BitmapFactory.decodeByteArray(data, 0, data.length);
            } catch (Exception ignored) { }
            final Bitmap bmp = b;
            if (bmp == null) return;
            images.put(url, bmp);
            ui.post(() -> {
                if (url.equals(into.getTag())) {
                    into.setAlpha(0f);
                    into.setImageBitmap(bmp);
                    into.animate().alpha(1f).setDuration(250).start();
                }
            });
        });
    }

    private static byte[] download(String url) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(6000);
        c.setReadTimeout(8000);
        c.setRequestProperty("User-Agent", "Mozilla/5.0"); // Yahoo Finance rejects requests without one.
        try (InputStream in = c.getInputStream()) {
            return readAll(in);
        } finally {
            c.disconnect();
        }
    }

    private static byte[] post(String url, String json) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(6000);
        c.setReadTimeout(8000);
        c.setDoOutput(true);
        c.setRequestMethod("POST");
        c.setRequestProperty("Content-Type", "application/json");
        try {
            c.getOutputStream().write(json.getBytes(StandardCharsets.UTF_8));
            try (InputStream in = c.getInputStream()) {
                return readAll(in);
            }
        } finally {
            c.disconnect();
        }
    }

    private static byte[] readAll(InputStream in) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[16384];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        return out.toByteArray();
    }

    // ---- App dock ----------------------------------------------------------

    private List<App> loadApps() {
        PackageManager pm = getPackageManager();
        Map<String, App> byPkg = new HashMap<>();
        for (String cat : new String[] {Intent.CATEGORY_LEANBACK_LAUNCHER, Intent.CATEGORY_LAUNCHER}) {
            Intent q = new Intent(Intent.ACTION_MAIN).addCategory(cat);
            for (ResolveInfo ri : pm.queryIntentActivities(q, 0)) {
                ActivityInfo ai = ri.activityInfo;
                if (ai.packageName.equals(getPackageName()) || byPkg.containsKey(ai.packageName)) continue;
                // Settings has its own button in the header.
                if (ai.packageName.equals("com.android.tv.settings")) continue;
                App a = new App();
                a.pkg = ai.packageName;
                a.label = String.valueOf(ri.loadLabel(pm));
                a.launch = new Intent(Intent.ACTION_MAIN).addCategory(cat)
                        .setComponent(new ComponentName(ai.packageName, ai.name))
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED);
                a.banner = ai.loadBanner(pm);
                if (a.banner == null) a.banner = ai.applicationInfo.loadBanner(pm);
                a.icon = ri.loadIcon(pm);
                byPkg.put(a.pkg, a);
            }
        }
        List<App> apps = new ArrayList<>(byPkg.values());
        apps.sort((x, y) -> {
            int ix = PREFERRED.indexOf(x.pkg), iy = PREFERRED.indexOf(y.pkg);
            if (ix < 0) ix = Integer.MAX_VALUE;
            if (iy < 0) iy = Integer.MAX_VALUE;
            if (ix != iy) return Integer.compare(ix, iy);
            return x.label.compareToIgnoreCase(y.label);
        });
        return apps;
    }

    /** Preview only (launched with --ez demo true): dock shows the Mi Box's app logos from assets/demo. */
    private List<App> loadDemoApps() {
        List<App> apps = new ArrayList<>();
        try {
            String[] files = getAssets().list("demo");
            Arrays.sort(files);
            for (String f : files) {
                App a = new App();
                a.label = f;
                a.pkg = f;
                try (InputStream in = getAssets().open("demo/" + f)) {
                    a.banner = Drawable.createFromStream(in, f);
                }
                a.launch = new Intent();
                apps.add(a);
            }
        } catch (Exception ignored) { }
        return apps;
    }

    private void buildDock() {
        dock.removeAllViews();
        List<App> apps = getIntent().getBooleanExtra("demo", false) ? loadDemoApps() : loadApps();
        // Full-size tiles; the band scrolls and clips them at its rounded edge.
        int w = dp(104), h = dp(58);
        for (int i = 0; i < apps.size(); i++) {
            View tile = makeAppTile(apps.get(i), w, h);
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(w, h);
            if (i > 0) lp.leftMargin = dp(14);
            dock.addView(tile, lp);
            if (i == 0) lockEnd(tile, true);
            if (i == apps.size() - 1) lockEnd(tile, false);
            if (i == 0 && lastFocused == null) {
                tile.requestFocus();
                lastFocused = tile;
            }
        }
    }

    private View makeAppTile(final App app, int w, int h) {
        FrameLayout card = new FrameLayout(this);
        GradientDrawable shape = new GradientDrawable();
        shape.setCornerRadius(dp(12));
        card.setBackground(shape);
        card.setOutlineProvider(ViewOutlineProvider.BACKGROUND);
        card.setClipToOutline(true);
        card.setFocusable(true);
        card.setElevation(dp(1));

        ImageView img = new ImageView(this);
        if (app.banner != null) {
            shape.setColor(Color.WHITE);
            img.setScaleType(ImageView.ScaleType.CENTER_CROP);
            img.setImageDrawable(app.banner);
            card.addView(img, new FrameLayout.LayoutParams(-1, -1));
        } else {
            shape.setColor(averageColor(app.icon));
            img.setScaleType(ImageView.ScaleType.FIT_CENTER);
            img.setImageDrawable(app.icon);
            card.addView(img, new FrameLayout.LayoutParams(h * 2 / 3, h * 2 / 3, Gravity.CENTER));
        }

        card.setOnFocusChangeListener((v, f) -> {
            v.animate().scaleX(f ? 1.14f : 1f).scaleY(f ? 1.14f : 1f).translationY(f ? -dp(3) : 0)
                    .translationZ(f ? dp(4) : 0).setDuration(160)
                    .setInterpolator(new DecelerateInterpolator()).start();
            if (f) lastFocused = v;
        });
        card.setOnClickListener(v -> safeStart(app.launch));
        return card;
    }

    // ---- Helpers -----------------------------------------------------------

    /** Left on the first item / right on the last stays put instead of jumping to another row. */
    private static void lockEnd(View v, boolean first) {
        if (v.getId() == View.NO_ID) v.setId(View.generateViewId());
        if (first) v.setNextFocusLeftId(v.getId());
        else v.setNextFocusRightId(v.getId());
    }

    private boolean safeStart(Intent i) {
        try {
            startActivity(i);
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    private static int averageColor(Drawable d) {
        if (d == null) return 0xFF3A3A44;
        Bitmap b = Bitmap.createBitmap(8, 8, Bitmap.Config.ARGB_8888);
        Canvas c = new Canvas(b);
        Drawable copy = d.getConstantState() != null ? d.getConstantState().newDrawable().mutate() : d;
        copy.setBounds(0, 0, 8, 8);
        copy.draw(c);
        long r = 0, g = 0, bl = 0, n = 0;
        for (int x = 0; x < 8; x++) for (int y = 0; y < 8; y++) {
            int p = b.getPixel(x, y);
            if (Color.alpha(p) < 128) continue;
            r += Color.red(p); g += Color.green(p); bl += Color.blue(p); n++;
        }
        if (n == 0) return 0xFF3A3A44;
        return Color.rgb((int) (r / n * 0.7), (int) (g / n * 0.7), (int) (bl / n * 0.7));
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    /** Small line icons for the header buttons. */
    private static class GlyphView extends View {
        static final int WIFI = 0, GEAR = 1, MOON = 2, SUN = 3;
        private final int kind;
        private final Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);

        GlyphView(Context c, int kind) {
            super(c);
            this.kind = kind;
            p.setColor(INK);
            p.setStyle(Paint.Style.STROKE);
            p.setStrokeCap(Paint.Cap.ROUND);
        }

        void setColor(int color) {
            p.setColor(color);
            invalidate();
        }

        @Override
        protected void onDraw(Canvas c) {
            float w = getWidth(), h = getHeight();
            p.setStrokeWidth(w * 0.11f);
            if (kind == MOON || kind == SUN) {
                float cx = w / 2, cy = h / 2;
                Paint.Style old = p.getStyle();
                p.setStyle(Paint.Style.FILL);
                if (kind == MOON) {
                    // Crescent: a disc with an offset disc cut out of it.
                    android.graphics.Path moon = new android.graphics.Path();
                    moon.addCircle(cx, cy, w * 0.42f, android.graphics.Path.Direction.CW);
                    android.graphics.Path bite = new android.graphics.Path();
                    bite.addCircle(cx + w * 0.22f, cy - w * 0.18f, w * 0.34f, android.graphics.Path.Direction.CW);
                    moon.op(bite, android.graphics.Path.Op.DIFFERENCE);
                    c.drawPath(moon, p);
                } else {
                    c.drawCircle(cx, cy, w * 0.2f, p);
                    p.setStyle(Paint.Style.STROKE);
                    for (int i = 0; i < 8; i++) {
                        double a = Math.PI / 4 * i;
                        c.drawLine(cx + (float) Math.cos(a) * w * 0.32f, cy + (float) Math.sin(a) * w * 0.32f,
                                cx + (float) Math.cos(a) * w * 0.46f, cy + (float) Math.sin(a) * w * 0.46f, p);
                    }
                }
                p.setStyle(old);
            } else if (kind == WIFI) {
                for (int i = 1; i <= 3; i++) {
                    float r = w * 0.17f * i + w * 0.02f;
                    RectF o = new RectF(w / 2 - r, h * 0.85f - r, w / 2 + r, h * 0.85f + r);
                    c.drawArc(o, 225, 90, false, p);
                }
            } else {
                // Cog: 8 square teeth around a solid ring, with a hole in the middle.
                float cx = w / 2, cy = h / 2, rOut = w * 0.48f, rIn = w * 0.36f;
                android.graphics.Path cog = new android.graphics.Path();
                int teeth = 8;
                for (int i = 0; i < teeth * 4; i++) {
                    double a = Math.PI * 2 * (i - 0.5) / (teeth * 4);
                    float r = (i % 4 == 1 || i % 4 == 2) ? rOut : rIn;
                    float x = cx + (float) Math.cos(a) * r, y = cy + (float) Math.sin(a) * r;
                    if (i == 0) cog.moveTo(x, y);
                    else cog.lineTo(x, y);
                }
                cog.close();
                cog.addCircle(cx, cy, w * 0.15f, android.graphics.Path.Direction.CCW);
                cog.setFillType(android.graphics.Path.FillType.EVEN_ODD);
                Paint.Style old = p.getStyle();
                p.setStyle(Paint.Style.FILL);
                c.drawPath(cog, p);
                p.setStyle(old);
            }
        }
    }
}
