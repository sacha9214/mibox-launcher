# Mi Box Launcher

Un écran d'accueil léger, inspiré de l'Apple TV, pour les box **Android TV** (testé sur une Xiaomi Mi Box S, Android 9).
Il remplace l'accueil Google TV, enlève les pubs et les recommandations, et rend une vieille box plus rapide.

| Mode clair | Mode sombre |
|---|---|
| ![Mode clair](docs/clair.png) | ![Mode sombre](docs/sombre.png) |

## Ce que ça fait

- **Affiches Netflix** : ce qui est populaire sur Netflix France, en onglets *Explorer*, *Films*, *Séries*, *Comédie* (comédies françaises) et *Animé* (animés japonais). Un clic ouvre **directement la fiche dans Netflix**. Les listes viennent de [JustWatch](https://www.justwatch.com) et se mettent à jour toutes les 6 h.
- **Dock d'apps** en bas, en verre dépoli. Les apps installées s'ajoutent toutes seules.
- **Ligne d'infos** en haut à droite : heure, cours d'EssilorLuxottica (EL), Bitcoin, Ethereum, Solana (toutes les 5 min) et RAM utilisée en %.
- **Mode sombre / clair** avec le bouton lune / soleil (le choix est mémorisé).
- Boutons Wi-Fi et Réglages.
- Aucune pub, aucun tracker, aucun compte. Une seule app de ~40 Ko, en Java pur, sans bibliothèque.

> Les cours et les classements ne sont donnés qu'à titre d'information.

---

## Tuto : l'installer sur ta box

Il te faut un **ordinateur** (Mac, Linux ou Windows) sur **le même Wi-Fi** que la box.

### 1. Activer le mode développeur sur la box

1. Sur la box : **Paramètres → Préférences de l'appareil → À propos**.
2. Descends sur **Build** et appuie **7 fois** dessus avec la télécommande. Un message dit que tu es développeur.
3. Retourne dans **Préférences de l'appareil → Options pour les développeurs** et active **Débogage USB** (et **Débogage réseau** s'il existe).
4. Note l'**adresse IP** de la box : **Paramètres → Réseau → ton Wi-Fi** (du genre `192.168.1.75`).

### 2. Installer ADB sur l'ordinateur

- **Mac** : `brew install --cask android-platform-tools`
- **Linux** : `sudo apt install adb`
- **Windows** : télécharge les [Platform Tools](https://developer.android.com/tools/releases/platform-tools) et ouvre un terminal dans le dossier.

### 3. Se connecter à la box

```bash
adb connect 192.168.1.75:5555
```

La TV affiche **« Autoriser le débogage ? »** : coche *Toujours autoriser* et valide. Puis vérifie :

```bash
adb devices
```

La box doit apparaître avec `device` à côté.

### 4. Installer le launcher

Télécharge `TvHome.apk` depuis la page [**Releases**](../../releases/latest), puis :

```bash
adb install -r TvHome.apk
```

### 5. En faire l'écran d'accueil

Désactive l'accueil Google (réversible) pour que le nouveau prenne la main :

```bash
adb shell pm disable-user --user 0 com.google.android.tvlauncher
adb shell input keyevent KEYCODE_HOME
```

C'est fini 🎉

---

## Bonus : nettoyer et accélérer la box (optionnel)

Tout est **réversible** (une réinitialisation d'usine remet aussi tout).

```bash
# Animations 2x plus rapides
adb shell settings put global window_animation_scale 0.5
adb shell settings put global transition_animation_scale 0.5
adb shell settings put global animator_duration_scale 0.5

# Retirer le tracker publicitaire Alphonso et les pubs/recommandations
adb shell pm uninstall --user 0 tv.alphonso.alphonso_eula
adb shell pm uninstall --user 0 com.google.android.tvrecommendations
```

Le script [`launcher/restore-mibox.sh`](launcher/restore-mibox.sh) fait tout d'un coup (installation, accueil, nettoyage complet d'une **Mi Box S**). Lis la liste des apps dedans avant de le lancer : elle retire aussi le Chromecast intégré et l'assistant vocal.

```bash
./launcher/restore-mibox.sh 192.168.1.75
```

Il cherche `TvHome.apk` dans le même dossier que lui (`launcher/`). Il sert aussi si une mise à jour remet l'ancien accueil.

## Revenir en arrière

```bash
adb shell pm enable com.google.android.tvlauncher
adb uninstall fr.sacha.tvhome
```

Pour une app retirée : `adb shell cmd package install-existing <nom.du.paquet>`.
Pour un service désactivé : `adb shell pm enable <nom.du.paquet>`.

---

## Personnaliser et compiler soi-même

Tout le code est dans [`HomeActivity.java`](launcher/src/fr/sacha/tvhome/HomeActivity.java) :

- **Ordre des apps du dock** : liste `PREFERRED`.
- **Onglets** : tableaux `TABS` / `TAB_FILTERS` (filtres JustWatch : genres, pays de production, films/séries).
- **Marges** : `col.setPadding(...)` dans `onCreate`, à ajuster si ta TV coupe les bords (overscan).

Compiler (sans Gradle) — prérequis sur Mac :

```bash
brew install openjdk@17
brew install --cask android-commandlinetools
sdkmanager "build-tools;34.0.0" "platforms;android-28"
./launcher/build.sh
```

`build.sh` utilise les chemins Homebrew ; adapte `JAVA_HOME` et `SDK` en haut du fichier sur une autre machine.
Il génère une clé de signature locale au premier lancement.

## Licence

MIT — fais-en ce que tu veux.
