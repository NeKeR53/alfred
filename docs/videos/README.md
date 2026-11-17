# Vidéos de la page de présentation

`docs/presentation.html` montre une démo par usage. Tant qu’aucune vidéo n’est déclarée, c’est la démo animée
(`docs/demos/demos.js`) qui est jouée. Dès qu’une vidéo est déclarée, elle la remplace.

## Les quatre vidéos

| Usage | Identifiant | Fichier |
|---|---|---|
| Vous demandez une page, je la construis | `creer-page` | `creer-page.mp4` |
| Vous branchez vos outils | `brancher-module` | `brancher-module.mp4` |
| Vous retrouvez tout | `rechercher` | `rechercher.mp4` |
| Un détail vous gêne ? Montrez-le-moi | `corriger` | `corriger.mp4` |

## Ajouter une vidéo

1. Enregistrez la fenêtre d’Alfred seule, sans le bureau autour, avec des données fictives.
2. Exportez-la et posez-la ici sous le nom du tableau :
   - format : MP4 (H.264) ; WebM (VP9) accepté, avec l’extension `.webm` ;
   - taille : 1600 × 1000 px conseillé (rapport 16:10, celui de l’emplacement), 1280 × 800 au minimum ;
   - durée : 30 à 60 s ; pas de son (la page la lit en muet) ;
   - poids : visez moins de 8 Mo, par exemple
     `ffmpeg -i brut.mov -vf scale=1600:-2 -c:v libx264 -crf 26 -preset slow -an -movflags +faststart creer-page.mp4`.
3. Facultatif, une affiche montrée avant la lecture : une image JPEG de même taille, `creer-page.jpg`
   (par exemple `ffmpeg -ss 3 -i creer-page.mp4 -frames:v 1 -q:v 3 creer-page.jpg`).
4. Déclarez-la dans `docs/presentation.html`, sur l’emplacement de l’usage :

   ```html
   <div class="dm" data-demo="creer-page" data-video="videos/creer-page.mp4" data-poster="videos/creer-page.jpg"></div>
   ```

   Laissez `data-poster=""` s’il n’y a pas d’affiche. Pour revenir à la démo animée, videz `data-video`.

La page ne vérifie pas elle-même si le fichier existe (ouverte en `file://`, elle ne le peut pas) : c’est la
déclaration qui compte. Ouvrez la page après l’ajout pour vérifier que la vidéo se lit.
