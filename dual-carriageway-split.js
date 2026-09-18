/*
 * dual-carriageway-split.js
 * ---------------------------------------------------------------
 * Skrypt dla wtyczki JOSM "Scripting" (API V3 / silnik GraalJS).
 *
 * Co robi:
 *   1. Pobiera zaznaczoną linię (lub linie) autostrady (highway=motorway).
 *   2. Dla każdej z nich tworzy równoległą kopię w ustalonej odległości
 *      (OFFSET_METERS), przesuniętą prostopadle do kierunku drogi.
 *   3. Nowa linia ma węzły w odwrotnej kolejności niż oryginał
 *      (czyli jej "zwrot" jest przeciwny - tak jak druga jezdnia
 *      dwujezdniowej drogi w OSM).
 *   4. Ustawia oneway=yes na OBU liniach (oryginalnej i nowej),
 *      zachowując przy tym pozostałe tagi oryginału (np. ref, name,
 *      lanes) skopiowane na nową linię.
 *
 * Wymagania:
 *   - JOSM Scripting Plugin w wersji używającej API V3 / GraalJS
 *     (Rhino / API V1 zostały usunięte z wtyczki od wersji 0.3.0).
 *   - Uruchamiać z zaznaczoną co najmniej jedną linią highway=motorway
 *     w aktywnej warstwie danych.
 *
 * Ograniczenie: przesunięcie liczone jest osobno dla każdego węzła
 * (na podstawie lokalnego kierunku drogi w tym miejscu), a nie pełną
 * geometrią buforowania (buffer). Dla linii z bardzo ostrymi zakrętami
 * może to dawać drobne zniekształcenia w narożnikach - dla typowych,
 * łagodnie zakrzywionych odcinków autostrady efekt jest poprawny.
 * ---------------------------------------------------------------
 */

import josm from 'josm'
import { NodeBuilder, WayBuilder } from 'josm/builder'
import { buildAddCommand, buildChangeCommand } from 'josm/command'

/* global Java */
const EastNorth = Java.type('org.openstreetmap.josm.data.coor.EastNorth')
const ProjectionRegistry = Java.type('org.openstreetmap.josm.data.projection.ProjectionRegistry')

/* ================= KONFIGURACJA ================= */
// Odległość między oryginalną a nową (równoległą) linią, w metrach.
// Wartość dodatnia przesuwa nową linię w jedną stronę, ujemna - w drugą
// (jeśli po uruchomieniu okaże się, że linia wylądowała po złej stronie
// drogi, wystarczy zmienić znak tej liczby i uruchomić skrypt ponownie
// na oryginalnej, niezmienionej linii).
const OFFSET_METERS = 20

/* ================================================== */

function javaMapToTagsObject(primitive) {
  const tags = {}
  const keys = primitive.getKeys() // java.util.Map<String,String>
  const it = keys.entrySet().iterator()
  while (it.hasNext()) {
    const entry = it.next()
    tags[String(entry.getKey())] = String(entry.getValue())
  }
  return tags
}

function javaListToArray(javaList) {
  const arr = []
  for (let i = 0; i < javaList.size(); i++) {
    arr.push(javaList.get(i))
  }
  return arr
}

function normalize(dx, dy) {
  const len = Math.sqrt(dx * dx + dy * dy)
  if (len === 0) return [0, 0]
  return [dx / len, dy / len]
}

// Dla każdego węzła liczy lokalny kierunek drogi (na podstawie sąsiednich
// węzłów), obraca go o 90 stopni i przesuwa węzeł o offsetMeters wzdłuż
// tak uzyskanego wektora prostopadłego. Liczone we współrzędnych
// projekcji (EastNorth), czyli w metrach - unika zniekształceń, jakie
// dałoby liczenie bezpośrednio na stopniach lat/lon.
function computeOffsetLatLons(nodes, offsetMeters) {
  const projection = ProjectionRegistry.getProjection()
  const pts = nodes.map(n => n.getEastNorth())
  const n = pts.length
  const result = []

  for (let i = 0; i < n; i++) {
    let dx = 0
    let dy = 0
    if (i > 0) {
      dx += pts[i].east() - pts[i - 1].east()
      dy += pts[i].north() - pts[i - 1].north()
    }
    if (i < n - 1) {
      dx += pts[i + 1].east() - pts[i].east()
      dy += pts[i + 1].north() - pts[i].north()
    }
    const [ux, uy] = normalize(dx, dy)
    // wektor prostopadły do kierunku drogi (obrócony o 90°)
    const nx = uy
    const ny = -ux
    const offsetEN = new EastNorth(
      pts[i].east() + nx * offsetMeters,
      pts[i].north() + ny * offsetMeters
    )
    result.push(projection.eastNorth2latlon(offsetEN))
  }
  return result
}

function processMotorwayWay(way, layer) {
  const originalNodes = javaListToArray(way.getNodes())
  if (originalNodes.length < 2) {
    josm.alert('Pominięto linię ' + way.getUniqueId() + ' - ma mniej niż 2 węzły.')
    return
  }

  // 1) policz przesuniętą geometrię (w tej samej kolejności co oryginał)
  const offsetLatLons = computeOffsetLatLons(originalNodes, OFFSET_METERS)

  // 2) zbuduj nowe węzły w ODWRÓCONEJ kolejności -> odwrotny zwrot linii
  const reversedLatLons = offsetLatLons.slice().reverse()
  const newNodes = reversedLatLons.map(ll =>
    NodeBuilder.withPosition(ll.lat(), ll.lon()).create()
  )

  // 3) tagi: kopia oryginału + wymuszone oneway=yes (na obu liniach)
  const originalTags = javaMapToTagsObject(way)
  const tagsWithOneway = Object.assign({}, originalTags, { oneway: 'yes' })

  // 4) nowa linia (przeciwny kierunek jazdy)
  const newWay = WayBuilder.withNodes(newNodes).withTags(tagsWithOneway).create()

  // 5) dodaj nowe węzły + nową linię jednym poleceniem (jeden krok cofania)
  buildAddCommand(newNodes.concat([newWay])).applyTo(layer)

  // 6) ustaw oneway=yes (zachowując resztę tagów) na oryginalnej linii
  buildChangeCommand(way, { tags: tagsWithOneway }).applyTo(layer)

  return newWay
}

function main() {
  const layer = josm.layers.activeLayer
  if (!layer) {
    josm.alert('Brak aktywnej warstwy danych.')
    return
  }

  const ds = layer.data
  const selectedWaysJava = ds.getSelectedWays()
  const selectedWays = []
  const iterator = selectedWaysJava.iterator()
  while (iterator.hasNext()) selectedWays.push(iterator.next())

  if (selectedWays.length === 0) {
    josm.alert('Zaznacz co najmniej jedną linię highway=motorway i uruchom skrypt ponownie.')
    return
  }

  const motorwayWays = selectedWays.filter(w => w.get('highway') === 'motorway')
  const skippedCount = selectedWays.length - motorwayWays.length

  if (motorwayWays.length === 0) {
    josm.alert('Żadna z zaznaczonych linii nie ma tagu highway=motorway.')
    return
  }

  const createdWays = []
  motorwayWays.forEach(way => {
    const newWay = processMotorwayWay(way, layer)
    if (newWay) createdWays.push(newWay)
  })

  // zaznacz efekt końcowy (oryginały + nowe linie), żeby było widać wynik
  try {
    const toSelect = motorwayWays.concat(createdWays)
    ds.setSelected(toSelect)
  } catch (e) {
    // zaznaczenie na końcu to tylko wygoda - błąd tutaj nie jest krytyczny
  }

  let msg = 'Utworzono ' + createdWays.length + ' równoległą(-e) linię(-e) '
    + '(przesunięcie ' + OFFSET_METERS + ' m), oneway=yes ustawione na obu kierunkach.'
  if (skippedCount > 0) {
    msg += '\nPominięto ' + skippedCount + ' zaznaczonych obiektów bez highway=motorway.'
  }
  josm.alert(msg)
}

main()
