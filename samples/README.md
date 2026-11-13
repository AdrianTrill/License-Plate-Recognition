# Samples

The demo's sample photos and videos, all from [Wikimedia Commons](https://commons.wikimedia.org). Each stays under its own license, listed below, and the demo credits its author on screen.

## Photos

Thirteen photos with plates from eight European countries, Brazil, the United States, and Vietnam, whose plate is on two lines. Each was scaled to 1280 pixels wide and saved again as a JPEG without its metadata; nothing else was changed.

[`samples.json`](samples.json) lists them for the demo and the checks, with the plates on each as a person reads them: the labels the demo, the native tests, and the site's checks compare readings with.

| File | Photo | Plates | Author | License |
| --- | --- | --- | --- | --- |
| [`ro-cluj-napoca.jpg`](ro-cluj-napoca.jpg) | Local police car, Cluj-Napoca | `CJ27CLC` | [Kyah117](https://commons.wikimedia.org/wiki/File:Politia_Locala_-_Cluj-Napoca_(3).jpg) | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0) |
| [`ro-sibiu.jpg`](ro-sibiu.jpg) | A police pickup and a Dacia Duster, Sibiu | `MAI58767`, `B108ZJE` | [Kyah117](https://commons.wikimedia.org/wiki/File:Ford_Politia_-_Bucarest.jpg) | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0) |
| [`ro-turda.jpg`](ro-turda.jpg) | Dacia 1310, Turda | `CJ14VXY` | [TrainSimFan](https://commons.wikimedia.org/wiki/File:2002_Dacia_1310_in_Turda.jpg) | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0) |
| [`de-golf.jpg`](de-golf.jpg) | Volkswagen Golf Variant, Germany | `HHQM8872` | [Alexander Migl](https://commons.wikimedia.org/wiki/File:Volkswagen_Golf_VIII_Variant_IMG_5348.jpg) | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0) |
| [`gb-captur.jpg`](gb-captur.jpg) | Renault Captur, United Kingdom | `AY23XCA` | [Calreyn88](https://commons.wikimedia.org/wiki/File:2023_Renault_Captur_RS_Line_TCe.jpg) | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0) |
| [`fr-dieppe.jpg`](fr-dieppe.jpg) | Two SUVs, Dieppe | `AA110YP`, `AA405TC` | [Mic from Reading - Berkshire, United Kingdom](https://commons.wikimedia.org/wiki/File:Dieppe,_Seine-Maritime_-_France_(11399342854).jpg) | [CC BY 2.0](https://creativecommons.org/licenses/by/2.0) |
| [`it-punto.jpg`](it-punto.jpg) | Fiat Punto, Italy | `EL333CK` | [Corvettec6r](https://commons.wikimedia.org/wiki/File:2015_Fiat_Punto_5-door_1.4_Natural_Power.jpg) | [CC0](http://creativecommons.org/publicdomain/zero/1.0/deed.en) |
| [`nl-vanquish.jpg`](nl-vanquish.jpg) | Aston Martin Vanquish, Netherlands | `GB713F`, `G592HD` | [Rutger van der Maar](https://commons.wikimedia.org/wiki/File:2014_Aston_Martin_Vanquish_Volante_5.9_V12_(52055905576).jpg) | [CC BY 2.0](https://creativecommons.org/licenses/by/2.0) |
| [`es-sevilla.jpg`](es-sevilla.jpg) | Local police car, Seville | `1512HNC` | [Nxr-at](https://commons.wikimedia.org/wiki/File:Sevilla_Seville_Local_Policia.jpg) | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0) |
| [`pl-gdansk.jpg`](pl-gdansk.jpg) | Toyota Aygo, Gdańsk | `GD560TM` | [Andrzej Otrębski](https://commons.wikimedia.org/wiki/File:Gdansk_Toyota_Aygo.jpg) | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0) |
| [`br-brasilia.jpg`](br-brasilia.jpg) | A convoy opening a tunnel, Brasília | `REL2D66`, `REL3E32` | [Agência Brasília from Brasília, Brasil](https://commons.wikimedia.org/wiki/File:Governador_Ibaneis_Rocha_entrega_T%C3%BAnel_Rei_Pel%C3%A9,_maior_obra_de_sua_gest%C3%A3o_(52952289062).jpg) | [CC BY 2.0](https://creativecommons.org/licenses/by/2.0) |
| [`us-california.jpg`](us-california.jpg) | Mercedes-Benz E 63 AMG, California | `6ARX058` | [Andy Rusch from Santa Barbara, USA](https://commons.wikimedia.org/wiki/File:Black_MB_E_63_AMG_rl.jpg) | [CC BY 2.0](https://creativecommons.org/licenses/by/2.0) |
| [`vn-nghe-an.jpg`](vn-nghe-an.jpg) | Honda motorbike with a two-line plate, Nghệ An | `37L214789` | [Lê Huỳnh Bộ](https://commons.wikimedia.org/wiki/File:Bi%E1%BB%83n_s%E1%BB%91_xe_Ngh%E1%BB%87_An.jpg) | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0) |

## Videos

Four clips, in [`videos/`](videos), for the demo's video mode. Two are excerpts and two were cropped to where the plates pass, as listed below; all four were encoded again as H.264 at 1280×720, at their own frame rate up to 30 frames a second, without their sound or metadata. Each has a poster frame from the clip for the demo's list.

[`videos.json`](videos.json) lists them, with every plate legible in each: the labels the demo checks its log against, and that [`tools/check_videos.py`](../tools/check_videos.py) requires the command line to report.

| File | Video | What was kept | Plates | Author | License |
| --- | --- | --- | --- | --- | --- |
| [`ro-cluj-napoca-traffic.mp4`](videos/ro-cluj-napoca-traffic.mp4) | Traffic on a tram line, Cluj-Napoca, 2012 | 0:08 to 0:20, after the title | `CJ027327`, `B36NWH`, `B35CKA`, `CJ92RSE`, `CJ26BCB`, `CJ01RMM` | [LDEGM Old Channel](https://commons.wikimedia.org/wiki/File:Trams_in_Cluj_Napoca_(15_08_2012).webm) | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0) |
| [`nl-2cv-parade.mp4`](videos/nl-2cv-parade.mp4) | A Citroën 2CV parade, eastern Netherlands, 2022 | 0:04 to 0:20, cropped from the 1080p version to the 1280×720 at (640, 240), where the cars come closest | `EP7242`, `90YD20`, `AR4597`, `7916NG`, `GL28ZR`, `BE6937`, `PM0187` | [OSeveno](https://commons.wikimedia.org/wiki/File:Multiple_Citro%C3%ABn_2CV_vehicles_driving_by_(east_Netherlands,_2022).webm) | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0) |
| [`ro-sibiu-taxi.mp4`](videos/ro-sibiu-taxi.mp4) | A taxi pushed to the station, Sibiu, 2014 | All of it | `SB27RMF`, `B45XNB` | [Draceane](https://commons.wikimedia.org/wiki/File:Sibiu,_taxik%C3%A1%C5%99i_p%C5%99ed_n%C3%A1dra%C5%BE%C3%ADm,_2014.webm) | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0) |
| [`fr-lyon-parking.mp4`](videos/fr-lyon-parking.mp4) | Parallel parking at night, Lyon, 2018 | All of it, cropped from the 1080p version to the 1280×720 at (0, 180), around the parking car, and halved to 30 frames a second | `BP843GS` | [Benoît Prieur](https://commons.wikimedia.org/wiki/File:Man%C5%93uvre_de_stationnement_de_type_cr%C3%A9neau_%C3%A0_Lyon_en_janvier_2018.webm) | [CC0](http://creativecommons.org/publicdomain/zero/1.0/deed.en) |

The Cluj-Napoca video was published on YouTube under CC BY 3.0 and imported to Commons, where a reviewer confirmed its license.
