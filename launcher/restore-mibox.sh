#!/bin/bash
# Remet le menu perso sur la Mi Box (après une mise à jour ou si l'accueil Google revient).
# Usage : ./restore-mibox.sh [ip]   (par défaut 192.168.1.75)
set -u
cd "$(dirname "$0")"
IP="${1:-192.168.1.75}:5555"
adb connect "$IP" >/dev/null
B() { adb -s "$IP" "$@"; }

B install -r TvHome.apk
B shell pm disable-user --user 0 com.google.android.tvlauncher

# Apps retirées (réversible : adb shell cmd package install-existing <paquet>)
for p in tv.alphonso.alphonso_eula com.miui.tv.analytics com.xm.webcontent com.google.android.tvrecommendations \
  com.mitv.tvhome.michannel com.mitv.tvhome.atv com.google.android.videos com.google.android.music \
  com.google.android.play.games com.google.android.youtube.tvmusic com.android.camera2 com.android.printspooler \
  com.google.android.apps.inputmethod.hindi com.google.android.apps.inputmethod.zhuyin \
  com.google.android.inputmethod.pinyin com.google.android.tv; do
  B shell pm uninstall --user 0 "$p" >/dev/null 2>&1
done

# Services désactivés (réversible : adb shell pm enable <paquet>)
for p in com.google.android.apps.mediashell com.google.android.katniss com.google.android.speech.pumpkin \
  com.google.android.backdrop com.xiaomi.mitv.updateservice com.mitv.milinkservice com.mitv.download.service \
  com.google.android.tv.bugreportsender com.google.android.feedback com.google.android.syncadapters.calendar \
  com.google.android.syncadapters.contacts; do
  B shell pm disable-user --user 0 "$p" >/dev/null 2>&1
done

for k in window_animation_scale transition_animation_scale animator_duration_scale; do
  B shell settings put global $k 0.5
done
B shell settings put secure screensaver_enabled 0

B shell input keyevent KEYCODE_HOME
echo "OK — accueil actuel : $(B shell dumpsys activity activities | grep -m1 mResumedActivity | grep -o '[a-z.]*/[A-Za-z.]*')"
