/// <reference path="../typings/globals/openlayers/index.d.ts" />
/// <reference path="../typings/I18n.d.ts" />
/// <reference path="../typings/waze.d.ts" />
/// <reference path="../typings/globals/jquery/index.d.ts" />
/// <reference path="../typings/wazewrap.d.ts" />
/// <reference path="../typings/greasyfork.d.ts" />
// ==UserScript==
// @name                WME Wide-Angle Lens
// @namespace           https://greasyfork.org/en/users/19861-vtpearce
// @description         Scan a large area
// @author              vtpearce and crazycaveman (progress bar from dummyd2 & seb-d59)
// @include             https://www.waze.com/editor
// @include             /^https:\/\/(www|beta)\.waze\.com\/(?!user\/)(.{2,6}\/)?editor.*$/
// @version             1.5.8
// @grant               none
// @copyright           2020 vtpearce
// @license             CC BY-SA 4.0
// @require             https://greasyfork.org/scripts/24851-wazewrap/code/WazeWrap.js
// @updateURL           https://greasyfork.org/scripts/40641-wme-wide-angle-lens/code/WME%20Wide-Angle%20Lens.meta.js
// @downloadURL         https://greasyfork.org/scripts/40641-wme-wide-angle-lens/code/WME%20Wide-Angle%20Lens.user.js
// ==/UserScript==

/* global W, OL, $, WazeWrap, OpenLayers, I18n */

namespace WMEWAL {

    const scrName = GM_info.script.name;
    const Version = GM_info.script.version;
    const updateText = '<ul>' +
        '<li>Allow for tightening up spacing a bit on the various plugins</li>' +
        '</ul>';
    const greasyForkPage = 'https://greasyfork.org/scripts/40641';
    const wazeForumThread = 'https://www.waze.com/forum/viewtopic.php?t=206376';

    const debug = true;

    class ProgressBar {
        private div: JQuery;

        constructor(id: string) {
            this.div = $(id);
        }

        public isShown(): boolean {
            return this.div.is(":visible");
        }

        public show(): void {
            this.div.show();
        }

        public hide(): void {
            this.div.hide();
        }

        public update(value: number): void {
            log("debug", "Percent complete = " + value.toString());
            if (value > 100) {
                value = 100;
            }
            if (value === -1) {
                this.div.children().hide();
                return;
            }

            this.div.children().show();
            this.div.children(".wal-progressBarBG").css("width", value.toString() + "%");
            this.div.children(".wal-progressBarFG").text(value.toString() + "%");
        }
    }

    export enum RoadType {
        Street = 1,
        PrimaryStreet = 2,
        MinorHighway = 4,
        MajorHighway = 8,
        Freeway = 16,
        Ramp = 32,
        PrivateRoad = 64,
        WalkingTrail = 128,
        Unpaved = 256,
        PedestrianBoardwalk = 512,
        Ferry = 1024,
        Stairway = 2048,
        Railroad = 4096,
        RunwayTaxiway = 8192,
        ParkingLotRoad = 16384,
        Alley = 32768
    }

    export enum OutputTo {
        CSV = 1,
        Tab = 2
    }

    enum ScanStatus {
        Continue = 1,
        Complete = 2,
        Abort = 3
    }

    export interface IPlugIn {
        Title: string;
        MinimumZoomLevel: number;
        SupportsSegments: boolean;
        SupportsVenues: boolean;
        GetTab(): string;
        TabLoaded(): void;
        ScanExtent(segments: Array<WazeNS.Model.Object.Segment>,
            venues: Array<WazeNS.Model.Object.Venue>): Promise<void>;
        ScanStarted(): boolean;
        ScanComplete(): void;
        ScanCancelled(): void;
    }

    interface ISettings {
        SavedAreas: Array<IArea>;
        ActivePlugins: Array<string>;
        OutputTo: string;
        Version: string;
        showLayer: boolean;
    }

    interface IPrivatePlugin extends IPlugIn {
        Active?: boolean;
        Id?: number;
    }

    interface ILayerState {
        layer: string;
        visibility: boolean;
    }

    interface IArea {
        name: string;
        geometry?: OpenLayers.Geometry;
        geometryText?: string;
    }

    let topLeft: OpenLayers.Geometry.Point = null;
    let bottomRight: OpenLayers.Geometry.Point = null;

    export let areaToScan: OpenLayers.Geometry.Collection = null;

    let height: number;
    let width: number;

    // let segments: Array<string> = null;
    // let venues: Array<string> = null;

    export let areaName: string = null;
    export let zoomLevel: number;
    export let outputTo: OutputTo;

    let currentX: number;
    let currentY: number;
    let currentCenter: OpenLayers.LonLat = null;
    let currentZoom: number = null;
    let layerToggle: Array<string> = null;
    let needSegments = false;
    let needVenues = false;
    let cancelled = false;
    let totalViewports: number;
    let countViewports: number;
    let mapReady = false;
    let modelReady = false;
    let settings: ISettings = null;
    let plugins: Array<IPrivatePlugin> = [];
    let settingsKey = "WMEWAL_Settings";
    let layerName = "WMEWAL_Areas";
    let pb: ProgressBar = null;
    let initCount = 0;
    let layerCheckboxAdded = false;
    let WALMap: OpenLayers.Map;

    async function WideAngleLens(): Promise<void> {
        console.group("WMEWAL: Initializing");
        initCount++;

        let allOK = true;
        let objectToCheck: Array<string> = ["W.map",
            "W.model.segments",
            "W.model.venues",
            "W.model.states",
            "W.model.events",
            "OpenLayers",
            "W.vent",
            "W.controller",
            "W.model.actionManager",
            "WazeWrap.Interface"];
        for (let i: number = 0; i < objectToCheck.length; i++) {
            let path = objectToCheck[i].split(".");
            let object: Window = window;
            let ok = true;
            for (let j = 0; j < path.length; j++) {
                object = object[path[j]];
                if (typeof object === "undefined" || object == null) {
                    console.warn(objectToCheck[i] + " NOT OK");
                    ok = false;
                    break;
                }
            }
            if (ok) {
                console.log(objectToCheck[i] + " OK");
            } else {
                allOK = false;
            }
        }

        if (!allOK) {
            if (initCount < 60) {
                console.groupEnd();
                setTimeout(WideAngleLens, 1000);
            } else {
                console.error("Giving up on initialization");
                console.groupEnd();
            }
            return;
        }

        if (typeof (Storage) !== "undefined") {
            if (localStorage[settingsKey]) {
                let upd: boolean = false;
                let settingsString = localStorage[settingsKey];
                if (settingsString.substring(0, 1) === "~") {
                    // Compressed value - decompress
                    //console.log("Decompress UTF16 settings");
                    settingsString = LZString.decompressFromUTF16(settingsString.substring(1));
                }
                try {
                    settings = JSON.parse(settingsString);
                } catch (e) {}

                if (typeof settings === "undefined" || settings === null) {
                    settings = null;
                    log("debug", "Using old decompress method");
                    localStorage[settingsKey + "Backup"] = localStorage[settingsKey]
                    settingsString = localStorage[settingsKey];

                    if (settingsString.substring(0, 1) === "~") {
                        // Compressed value - decompress
                        settingsString = LZString.decompress(settingsString.substring(1));
                    }
                    try {
                        settings = JSON.parse(settingsString);
                    } catch (e) {}
                    if (typeof settings === "undefined" || settings === null) {
                        log("warning", "Unable to decompress! Using empty settings");
                        outputTo = OutputTo.CSV;
                        settings = {
                            SavedAreas: [],
                            ActivePlugins: [],
                            OutputTo: "csv",
                            Version: Version,
                            showLayer: false
                        };
                    }
                    upd = true;
                }

                settings.SavedAreas.sort(function (a, b) {
                    return a.name.localeCompare(b.name);
                });

                delete this.settingsString;
                if (!settings.hasOwnProperty("Version")) {
                    settings.Version = Version;
                    upd = true;
                }
                if (!settings.hasOwnProperty("showLayer")) {
                    settings.showLayer = false;
                    upd = true;
                }

                for (let ix = 0; ix < settings.SavedAreas.length; ix++) {
                    if (settings.SavedAreas[ix].geometryText) {
                        settings.SavedAreas[ix].geometry = <OpenLayers.Geometry> OpenLayers.Geometry.fromWKT(settings.SavedAreas[ix].geometryText);
                        while ((settings.SavedAreas[ix].geometry.CLASS_NAME === "OL.Geometry.Collection" ||
                                settings.SavedAreas[ix].geometry.CLASS_NAME === "OpenLayers.Geometry.Collection") &&
                                (<OpenLayers.Geometry.Collection> settings.SavedAreas[ix].geometry).components.length === 1) {
                            settings.SavedAreas[ix].geometry = (<OpenLayers.Geometry.Collection> settings.SavedAreas[ix].geometry).components[0];
                            upd = true;
                        }
                        delete settings.SavedAreas[ix].geometryText;
                    }
                }

                if (upd) {
                    updateSettings();
                }
            } else if (localStorage["WMEMSL_areaList"]) {
                // Import settings from old MSL script
                let savedAreas = JSON.parse(localStorage["WMEMSL_areaList"]);
                savedAreas.sort(function (a, b) {
                    return a.name.localeCompare(b.name);
                });
                outputTo = OutputTo.CSV;
                settings = {
                    SavedAreas: savedAreas,
                    ActivePlugins: [],
                    OutputTo: "csv",
                    Version: Version,
                    showLayer: false
                };
                for (let ix = 0; ix < settings.SavedAreas.length; ix++) {
                    if (settings.SavedAreas[ix].geometryText) {
                        settings.SavedAreas[ix].geometry = <OpenLayers.Geometry> OpenLayers.Geometry.fromWKT(settings.SavedAreas[ix].geometryText);
                        delete settings.SavedAreas[ix].geometryText;
                    }
                }

            } else {
                outputTo = OutputTo.CSV;
                settings = {
                    SavedAreas: [],
                    ActivePlugins: [],
                    OutputTo: "csv",
                    Version: Version,
                    showLayer: false
                };
            }
        }

        /*if (CompareVersions(settings.Version, Version) < 0) {
            var versionHistory = "WME Wide-Angle Lens\nv" + Version + "\n\nWhat's New\n--------";
            if (CompareVersions(settings.Version, "1.4.7") < 0) {
                versionHistory += "\nv1.4.7: Choose output on scan tab for all plugins";
            }
            if (CompareVersions(settings.Version, "1.4.6") < 0) {
                versionHistory += "\nv1.4.6: Fixes for the latest release of WME";
            }
            if (CompareVersions(settings.Version, "1.4.5") < 0) {
                versionHistory += "\nv1.4.5: Fixes for the latest release of WME";
            }
            if (CompareVersions(settings.Version, "1.4.4") < 0) {
                versionHistory += "\nv1.4.4: Show tab when changing mode or unit\n"+
                                    "        Always hide segments when scanning";
            }
            if (CompareVersions(settings.Version, "1.4.3.1") < 0) {
                versionHistory += "\nv1.4.3.1: Fix for Firefox unable to load settings";
            }
            if (CompareVersions(settings.Version, "1.4.3") < 0) {
                versionHistory += "\nv1.4.3: Add Alley road type and fixes for WME release";
            }
            if (CompareVersions(settings.Version, "1.4.2") < 0) {
                versionHistory += "\nv1.4.2: Fix tab placement";
            }
            if (CompareVersions(settings.Version, "1.4.1") < 0) {
                versionHistory += "\nv1.4.1: Hotfix for 1.4.0";
            }
            if (CompareVersions(settings.Version, "1.4.0") < 0) {
                versionHistory += "\nv1.4.0: Updates to support Firefox.";
            }
            /*if (CompareVersions(settings.Version, "1.3.4.1") < 0) {
                versionHistory += "\nv1.3.4.1: ***BACKUP YOUR AREAS NOW!!***\nThe next version of WAL"+
                                  " could potentially cause data loss.\nSee the forum thread for more info";
            }
            if (CompareVersions(settings.Version, "1.3.4") < 0) {
                versionHistory += "\nv1.3.4: Updates to WME URL";
            }
            if (CompareVersions(settings.Version, "1.3.3") < 0) {
                versionHistory += "\nv1.3.3: Updates to support latest version of WME Editor.";
            }
            alert(versionHistory);
            settings.Version = Version;
            updateSettings();
        }*/

        WazeWrap.Interface.ShowScriptUpdate(scrName, Version, updateText, greasyForkPage, wazeForumThread);

        let style = document.createElement("style");
        style.type = "text/css";
        let css = ".wal-heading { font-size: 1.2em; font-weight: bold }";
        css += ".wal-indent { padding-left: 20px }";
        css += ".wal-label { margin-left: 8px; font-weight: normal; margin-bottom: 0px }";
        css += '.wal-check { margin-top: 0px }';
        css += "#wal-progressBarInfo { display: none; width: 90%; float: left; position: absolute; border-top-left-radius: 5px; border-top-right-radius: 5px; border-bottom-right-radius: 5px; border-bottom-left-radius: 5px; margin-bottom: -100%; background-color: #c9e1e9; z-index: 999; margin: 5px; margin-right: 20px; }";
        css += ".wal-progressBarBG { margin-top: 2px; margin-bottom: 2px; margin-left: 2px; margin-right: 2px; padding-bottom: 0px; padding-top: 0px; padding-left: 0px; padding-right: 0px; width: 33%; background-color: #93c4d3; border: 3px rgb(147, 196, 211); border-top-left-radius: 5px; border-top-right-radius: 5px; border-bottom-right-radius: 5px; border-bottom-left-radius: 5px; height: 22px;}";
        css += ".wal-progressBarFG { float: left; position: relative; bottom: 22px; height: 0px; text-align: center; width: 100% }";
        css += ".wal-textbox { width: 100% }";
        style.innerHTML = css;
        document.body.appendChild(style);

        console.log("Initialized");
        console.groupEnd();

        makeTab();

        //recreate tab here
        // Editing mode changed to/from event mode

        if (W.app.modeController) {
            W.app.modeController.model.bind("change:mode", function (model, modeId) {
                if (modeId === 0 && $("#sidepanel-wme-wal").length === 0) {
                    log("debug", "Mode changed");
                    recreateTab();
                }
            });
        }

        // Unit switched (imperial/metric)
        if (W.prefs) {
            W.prefs.on("change:isImperial", recreateTab);
        }

        // Create map object
        WALMap = W.map.getOLMap();

        window["WMEWAL"] = WMEWAL;
    }

    function makeTab(): void {
        let userTabs = $("#user-info");
        let navTabs = $("ul.nav-tabs", userTabs).filter(":first");
        let tabContent = $(".tab-content", userTabs).filter(":first");

        navTabs.append("<li><a href='#sidepanel-wme-wal' data-toggle='tab'>WAL</a></li>");

        let addon = $("<div id='sidepanel-wme-wal' class='tab-pane'><h3>Wide-Angle Lens <span style='font-size:11px;'>v"+ Version +"</span></h3></div>");

        let pbi = $("<div/>").attr("id", "wal-progressBarInfo").addClass("wal-ProgressBarInfo").appendTo(addon);

        let pb$ = $("<div/>").attr("id", "wal-progressBar").css({ width: "100%", display: "none" }).appendTo(pbi);
        pb$.append($("<div/>").addClass("wal-progressBarBG"));
        pb$.append($("<span/>").addClass("wal-progressBarFG").text("100%"));
        pbi.append("<div id='wal-info'/>");

        let addonTabs = $("<ul id='wmewal-tabs' class='nav nav-tabs' style='width: 95%;'/>").appendTo(addon);
        addonTabs.append("<li class='active'><a data-toggle='tab' href='#sidepanel-wmewal-scan'>Scan</a></li>");
        addonTabs.append("<li><a data-toggle='tab' href='#sidepanel-wmewal-areas'>Areas</a></li>");

        let addonTabContent = $("<div class='tab-content'/>").appendTo(addon);
        let tabScan = $("<div class='tab-pane active' id='sidepanel-wmewal-scan'/>").appendTo(addonTabContent);
        tabScan.append("<div><b>Output to: </b><select class='form-control' id='_wmewalScanOutputTo'><option value='csv'>CSV File</option><option value='tab'>Browser Tab</option>" +
        "<option value='both'>Both CSV File and Browser Tab</option></select></div><hr/>");
        tabScan.append("<div><b>Active Plug-Ins</b><div id='_wmewalPlugins'></div>");
        tabScan.append("<div><b>Scan</b><div id='_wmewalOptionsSavedAreas' name='_wmewalSavedAreas'/></div>");
        tabScan.append("<hr/>");

        let divButtons = $("<div/>").appendTo(tabScan);
        divButtons.append("<button class='btn btn-primary' id='_wmewalScan' title='Scan' style='margin-right: 8px'>Scan</button>");
        divButtons.append("<button class='btn btn-primary' id='_wmewalCancel' title='Cancel' disabled='disabled'>Cancel</button>");

        let tabAreas = $("<div class='tab-pane' id='sidepanel-wmewal-areas'/>").appendTo(addonTabContent);
        tabAreas.append("<div id='_wmewalAreasSavedAreas' name='_wmewalSavedAreas'/>");

        let divAreaButtons = $("<div/>").appendTo(tabAreas);
        divAreaButtons.append("<button class='btn btn-primary' id='_wmewalDeleteArea' title='Delete' style='margin-right: 4px'>Delete</button>");
        divAreaButtons.append("<button class='btn btn-primary' id='_wmewalExport' title='Export' style='margin-right: 4px'>Export</button>");
        divAreaButtons.append("<button class='btn btn-primary' id='_wmewalRenameArea' title='Rename'>Rename</button>");

        tabAreas.append("<div style='margin-top: 12px'><b>Add custom area</b>");
        tabAreas.append("<div>From an unsaved area place<div>Name area: <input type='text' id='_wmewalNewAreaName'></div><div>Then <button id='_wmewalAddNewArea' class='btn btn-primary' title='Add'>Add</button></div></div></div>");

        let divImportArea = $("<div style='margin-top: 12px'/>").appendTo(tabAreas);
        divImportArea.append("<b>Import area</b>");
        divImportArea.append("<div><input type='file' id='_wmewalImportFileName' accept='.wkt'/></div><div><button class='btn btn-primary' id='_wmewalImportFile' title='Import'>Import</input></div>");

        tabContent.append(addon);

        $("#_wmewalScanOutputTo").val(settings.OutputTo || "csv");
        outputTo = parseOutputTo(settings.OutputTo || "csv");

        updateSavedAreasList();

        $("#_wmewalScanOutputTo").on("change", updateSettings);
        $("#_wmewalAddNewArea").on("click", addNewArea);
        $("#_wmewalCancel").on("click", cancelScan);
        $("#_wmewalScan").on("click", scanArea);
        $("#_wmewalExport").on("click", exportArea);
        $("#_wmewalRenameArea").on("click", renameArea);
        $("#_wmewalDeleteArea").on("click", deleteArea);
        $("#_wmewalImportFile").on("click", importFile);
        $("#_wmewalPlugins").on("click", function (e) {
            $("input[name=_wmewalPlugin]").each(function (ix, item) {
                let i = $(item);
                let id = i.attr("data-id");
                for (let index = 0; index < plugins.length; index++) {
                    if (plugins[index].Id === parseInt(id)) {
                        plugins[index].Active = i.prop("checked");
                    }
                }
            });
            settings.ActivePlugins = [];
            for (let ix = 0; ix < plugins.length; ix++) {
                if (plugins[ix].Active) {
                    settings.ActivePlugins.push(plugins[ix].Title);
                }
            }
            updateSettings();
        });
    }

    function recreateTab(): void {
        log("Debug","Tab stuff");
        makeTab();
        plugins.forEach(function (plugin) {
            log("Debug","Running for plugin: " + plugin.Title);
            updatePluginList();
            addPluginTab(plugin);
        });
    }

    function info(text: string): void {
        text = (typeof text !== "undefined" ? text : "");
        $("#wal-info").text(text);
    }

    function showPBInfo(show: boolean): void {
        if (show) {
            $("#wal-progressBarInfo").show();
        } else {
            $("#wal-progressBarInfo").hide();
        }
    }

    function addPluginTab(plugin: IPrivatePlugin): void {
        let sidepanel = $("#sidepanel-wme-wal");

        let tabs = $("#wmewal-tabs", sidepanel);

        tabs.append("<li><a data-toggle='tab' href='#" + plugin.Id + "'>" + plugin.Title + "</a></li>");

        let tabContent = $("div.tab-content", sidepanel);
        let tab = $("<div class='tab-pane' id='" + plugin.Id + "'/>");
        tab.append(plugin.GetTab());
        tabContent.append(tab);
        if (plugin.TabLoaded) {
            plugin.TabLoaded();
        }
    }

    function updatePluginList(): void {
        let list = $("#_wmewalPlugins");
        list.empty();

        for (let ix = 0; ix < plugins.length; ix++) {
            let id = "_wmewalPlugin_" + plugins[ix].Id.toString();
            if (ix > 0) {
                list.append("<br/>");
            }
            let c = $("<input type='checkbox' name='_wmewalPlugin'/>")
                .attr({ id: id, title: plugins[ix].Title, "data-id": plugins[ix].Id }).appendTo(list);
            if (plugins[ix].Active) {
                c.attr("checked", "checked");
            }
            list.append($("<label/>").attr("for", id).css("margin-left", "8px").text(plugins[ix].Title));
        }
    }

    export function RegisterPlugIn(plugin: IPlugIn): void {
        let p: IPrivatePlugin = plugin;

        let found = false;
        let r: number;
        do {
            r = Math.ceil(Math.random() * 1000);
            for (let ix = 0; ix < plugins.length; ix++) {
                if (plugins[ix].Id === r) {
                    found = true;
                    break;
                }
            }
        } while (found);

        p.Id = r;

        p.Active = (settings.ActivePlugins.indexOf(plugin.Title) !== -1);

        plugins.push(p);
        updatePluginList();
        addPluginTab(p);
    }

    export function IsSegmentInArea(segment: WazeNS.Model.Object.Segment): boolean {
        return areaToScan.intersects(segment.geometry);
    }

    function getVenueGeometry(venue: WazeNS.Model.Object.Venue): OpenLayers.Geometry {
        if (venue.isPoint()) {
            return venue.getPointGeometry();
        } else {
            return venue.getPolygonGeometry();
        }
    }

    export function IsVenueInArea(venue: WazeNS.Model.Object.Venue): boolean {
            return areaToScan.intersects(getVenueGeometry(venue));
    }

    function getMapCommentGeometry(mapComment: WazeNS.Model.Object.MapComment): OpenLayers.Geometry {
        if (mapComment.isPoint()) {
            return mapComment.getPointGeometry();
        } else {
            return mapComment.getPolygonGeometry();
        }
    }

    export function IsMapCommentInArea(mapComment: WazeNS.Model.Object.MapComment): boolean {
        return areaToScan.intersects(getMapCommentGeometry(mapComment));
    }

    function updateLayer(): void {
        let features: Array<OpenLayers.Feature.Vector> = [];

        let maLayer = W.map.getLayerByUniqueName(layerName);
        if (maLayer === null || typeof maLayer === "undefined") {
            maLayer = new OpenLayers.Layer.Vector("Wide-Angle Lens Areas", {
                uniqueName: layerName
            });
            I18n.translations[I18n.currentLocale()].layers.name[layerName] = "Wide-Angle Lens Areas";
            W.map.addUniqueLayer(maLayer);
            maLayer.setVisibility(settings.showLayer);
        }

        maLayer.removeAllFeatures({
            silent: true
        });

        for (let ixA = 0; ixA < settings.SavedAreas.length; ixA++) {
            let style = {
                strokeColor: "#FF6600",
                strokeOpacity: 0.8,
                strokeWidth: 3,
                fillOpacity: 0.00,
                label: settings.SavedAreas[ixA].name,
                labelOutlineColor: "Black",
                labelOutlineWidth: 3,
                fontSize: 14,
                fontColor: "#FF6600",
                fontOpacity: 0.85,
                fontWeight: "bold"
            };
            features.push(new OpenLayers.Feature.Vector(settings.SavedAreas[ixA].geometry.clone(), {
                areaName: settings.SavedAreas[ixA].name,
            }, style));
        }

        maLayer.addFeatures(features);

        if (!layerCheckboxAdded) {
            WazeWrap.Interface.AddLayerCheckbox("display", "Wide-Angle Lens Areas", settings.showLayer, function (checked) {
                maLayer.setVisibility(checked);
                settings.showLayer = checked;
                updateSettings();
            });
            layerCheckboxAdded = true;
        }
    }

    // function addLatLonArray(latLonArray, arrayName): void
    // {
    //     let points: Array<OpenLayers.Geometry> = [];
    //     for (let i = 0; i < latLonArray.length; i++)
    //     {
    //         points.push(new OpenLayers.Geometry.Point(latLonArray[i].lon, latLonArray[i].lat).transform(new OpenLayers.Projection("EPSG:4326"), W.map.getProjectionObject()));
    //     }

    //     let ring = new OpenLayers.Geometry.LinearRing(points);
    //     let polygon = new OpenLayers.Geometry.Polygon([ring]);

    //     savedAreas.push({name: arrayName, geometry: polygon});
    // }

    function addNewArea(): void {
        let theVenue: WazeNS.Model.Object.Venue = null;
        let count = 0;
        for (let v in W.model.venues.objects) {
            if (W.model.venues.objects.hasOwnProperty(v) === false) {
                continue;
            }
            let venue = W.model.venues.objects[v];
            if (venue.isPoint() === true) {
                continue;
            }
            if ($.isNumeric(venue.attributes.id) && parseInt(venue.attributes.id) <= 0) {
                theVenue = venue;
                count++;
            }
        }

        if (count > 1) {
            alert("There must be only one unsaved area place.\n" + count + " detected.\nDraw only one area place to scan.");
            return;
        }

        if (count === 0) {
            alert("You must drawn an area place and not save it.");
            return;
        }

        if (theVenue.geometry.components.length !== 1) {
            alert("Can't parse the geometry");
            return;
        }

        let nameBox = <HTMLInputElement> $("#_wmewalNewAreaName")[0];

        if (nameBox.value.trim().length === 0) {
            alert("Please provide a name for the new area.");
            return;
        }

        let savedArea: IArea = {
            name: nameBox.value.trim(),
            geometry: theVenue.geometry.clone()
        };
        settings.SavedAreas.push(savedArea);
        updateSavedAreasList();

        if (W.model.actionManager.canUndo()) {
            if (confirm("Undo all edits (OK=Yes, Cancel=No)?")) {
                /* tslint:disable:no-empty */
                while (W.model.actionManager.undo()) {
                }
            }
        }

        return;
    }

    function removeSavedArea(index: number): void {
        if (index >= settings.SavedAreas.length) {
            return;
        }

        if (confirm("Removed saved area?")) {
            settings.SavedAreas.splice(index, 1);

            updateSavedAreasList();
        }
    }

    function updateSavedAreasList(): void {
        function getCenterFunc(index: number): any {
            return function () {
                let center = settings.SavedAreas[index].geometry.getCentroid();
                let lonlat = new OpenLayers.LonLat(center.x, center.y);
                W.map.setCenter(lonlat);
            };
        }

        settings.SavedAreas.sort(function (a, b) {
            return a.name.localeCompare(b.name);
        });

        let list = $("div[name=_wmewalSavedAreas]");
        list.empty();

        list.each(function (eIx, e) {
            for (let ix = 0; ix < settings.SavedAreas.length; ix++) {
                let id = "_wmewalScanArea_" + eIx.toString() + "_" + ix.toString();
                let input = $("<input/>").attr({ type: "radio", name: "_wmewalScanArea", id: id, value: ix.toString() });
                e.appendChild(input[0]);

                let label = $("<label/>").attr("for", id).css("margin-left", "8px").text(settings.SavedAreas[ix].name);
                e.appendChild(label[0]);

                let center = $("<i/>").addClass("fa").addClass("fa-crosshairs").css("margin-left", "4px").on("click", getCenterFunc(ix));
                e.appendChild(center[0]);

                // var div = document.createElement('div');
                // var link = document.createElement('a');
                // link.href = '#';
                // link.onclick = (function (index) {
                //     return function() {
                //         scanArea(index);
                //     };
                // })(ix);
                // link.text = savedAreas[ix].name;
                // div.appendChild(link);

                // e.appendChild(document.createTextNode("\u00A0"));
                // e.appendChild(delLink);

                let br = $("<br/>");
                e.appendChild(br[0]);
            }
        });

        updateSettings();
        updateLayer();
    }

    function updateSettings(): void {
        if (typeof Storage !== "undefined") {
            outputTo = parseOutputTo($("#_wmewalScanOutputTo").val());
            let newSettings: ISettings = {
                SavedAreas: [],
                ActivePlugins: settings.ActivePlugins,
                OutputTo: $("#_wmewalScanOutputTo").val(),
                Version: settings.Version,
                showLayer: settings.showLayer
            };
            for (let ix = 0; ix < settings.SavedAreas.length; ix++) {
                newSettings.SavedAreas.push({
                    name: settings.SavedAreas[ix].name,
                    geometryText: settings.SavedAreas[ix].geometry.toString()
                });
            }
            localStorage[settingsKey] = "~" + LZString.compressToUTF16(JSON.stringify(newSettings));
        }
    }

    function importFile(): void {
        let input = <HTMLInputElement> $("#_wmewalImportFileName")[0];
        if (input.files.length === 0) {
            alert("Select a file to import.");
            return;
        }

        let fileName = input.files[0].name;
        let fileExt = fileName.split(".").pop();
        let name = fileName.replace("." + fileExt, "");

        let reader = new FileReader();
        reader.onload = function (e) {
            let parser = new OpenLayers.Format.WKT();
            let features = parser.read(<string>(<FileReader> e.target).result);

            let feature: OpenLayers.Feature.Vector;
            while (features instanceof Array && (<OpenLayers.Feature.Vector[]> features).length === 1) {
                features = features[0];
            }
            if (features instanceof OpenLayers.Feature.Vector) {
                feature = <OpenLayers.Feature.Vector> features;
            } else {
                alert("Could not parse geometry.");
                return;
            }
            // Assume geometry is in EPSG:4326 and reproject to Spherical Mercator
            let fromProj = new OpenLayers.Projection("EPSG:4326");
            let c = <OpenLayers.Geometry.Collection> feature.geometry.clone();
            c.transform(fromProj, W.map.getProjectionObject());

            let savedArea: IArea = {
                name: name,
                geometry: c
            };
            settings.SavedAreas.push(savedArea);
            updateSavedAreasList();
        };

        reader.readAsText(input.files[0]);
    }

    function getBounds(): void {
        if (areaToScan == null) {
            return;
        }

        areaToScan.calculateBounds();
        let bounds = areaToScan.getBounds();
        topLeft = new OpenLayers.Geometry.Point(bounds.left, bounds.top);
        bottomRight = new OpenLayers.Geometry.Point(bounds.right, bounds.bottom);
    }

    // function onOperationDone(context: any): void {
    //     log("Debug","onOperationDone started");
    //     // Handle situation where onOperationDone is triggered twice.
    //     if (!cancelled) {
    //         scanExtent()
    //             .done(function () {
    //                 log("Debug","scanExtent deferred done.");
    //                 let progress = Math.floor(countViewports / totalViewports * 100);
    //                 pb.update(progress);

    //                 moveToNextLocation();
    //             })
    //             .fail(function() {
    //                 log("Debug","scanExtent deferred failed.");
    //                 alert("There was a problem with one of the plugins and the scan is being canceled.");
    //                 cancel();
    //             });
    //     }
    // }

    function onModelReadyWW(): Promise<void> {
        return new Promise<void>(resolve => {
            WazeWrap.Model.onModelReady(function () {
                resolve();
            }, true, null);
        });
    }

    function onModelReady(now: boolean): Promise<any> {
        let modelPromise: Promise<void> = new Promise(resolve => {
            let mergeend = function () {
                resolve();
                W.model.events.unregister("mergeend", null, mergeend);
            };
            W.model.events.register("mergeend", null, mergeend);
        });

        let mapPromise : Promise<void> = new Promise(resolve => {
            let operationDone = function () {
                resolve();
                W.vent.off("operationDone", operationDone);
            };
            W.vent.on("operationDone", operationDone);
        });

        if (now && WazeWrap.Util.mapReady() && WazeWrap.Util.modelReady()) {
            return Promise.resolve();
        } else {
            return Promise.all([modelPromise, mapPromise]);
        }
    };

    function cancelScan(): void {
        cancelled = true;
    }

    function cancel(): void {
        for (let ix = 0; ix < plugins.length; ix++) {
            if (plugins[ix].Active && plugins[ix].ScanCancelled) {
                try {
                    plugins[ix].ScanCancelled();
                } catch (e) {
                    log("warning",`Trouble cancelling plugin ${plugins[ix].Title}\n${e.message}`);
                }
            }
        }

        resetState();
    }

    function processComplete(): void {
        pb.update(100);

        for (let ix = 0; ix < plugins.length; ix++) {
            if (plugins[ix].Active && plugins[ix].ScanComplete) {
                plugins[ix].ScanComplete();
            }
        }

        resetState();
    }

    function alertBeforeClose(e: any): boolean {
        if (areaToScan !== null) {
            log("Debug",'Alerting user before closing page');
            e.preventDefault();
            e.returnValue = 'Scan running. Cancel and leave the page?';
            return e.returnValue;
        } else {
            return false;
        }
    }

    function resetState() {
        pb.hide();
        showPBInfo(false);
        info("");

        areaToScan = null;

        // Return to previous state
        if (layerToggle != null) {
            while (layerToggle.length > 0) {
                let ln = layerToggle.pop();
                $("#" + ln).trigger("click");
            }

            layerToggle = null;
        }
        if (currentCenter != null) {
            log("Debug","Moving back to original location");
            W.map.setCenter(currentCenter);
        }
        if (currentZoom != null) {
            log("Debug","Resetting zoom");
            WALMap.zoomTo(currentZoom);
        }

        // segments = null;
        // venues = null;

        $("#_wmewalCancel").attr("disabled", "disabled");
        // Remove listeners for unloading page
        window.removeEventListener('beforeunload', alertBeforeClose);
        window.removeEventListener('unload', cancel);

    }

    function exportArea() {
        let index = -1;
        let nodes = $("input[name=_wmewalScanArea]", "#_wmewalAreasSavedAreas");
        for (let ix = 0; ix < nodes.length; ix++) {
            if ((<HTMLInputElement> nodes[ix]).checked) {
                index = ix;
                break;
            }
        }

        if (index === -1) {
            alert("Please select an area to export.");
            return;
        } else if (index >= settings.SavedAreas.length) {
            return;
        }

        let c = new OpenLayers.Geometry.Collection([settings.SavedAreas[index].geometry.clone()]);
        // Transform the collection to EPSG:4326
        let toProj = new OpenLayers.Projection("EPSG:4326");
        c.transform(W.map.getProjectionObject(), toProj);

        let geoText = c.toString();
        let encodedUri = "data:text/plain;charset=utf-8," + encodeURIComponent(geoText);
        let link = <HTMLAnchorElement> document.createElement("a");
        link.setAttribute("href", encodedUri);
        link.setAttribute("download", settings.SavedAreas[index].name + ".wkt");
        let node = document.body.appendChild(link);
        link.click();
        document.body.removeChild(node);
    }

    function deleteArea() {
        let index = -1;
        let nodes = $("input[name=_wmewalScanArea]", "#_wmewalAreasSavedAreas");
        for (let ix = 0; ix < nodes.length; ix++) {
            if ((<HTMLInputElement> nodes[ix]).checked) {
                index = ix;
                break;
            }
        }

        if (index === -1) {
            alert("Please select an area to delete.");
            return;
        } else if (index >= settings.SavedAreas.length) {
            return;
        }

        removeSavedArea(index);
    }

    function renameArea() {
        let index = -1;
        let nodes = $("input[name=_wmewalScanArea]", "#_wmewalAreasSavedAreas");
        for (let ix = 0; ix < nodes.length; ix++) {
            if ((<HTMLInputElement> nodes[ix]).checked) {
                index = ix;
                break;
            }
        }

        if (index === -1) {
            alert("Please select an area to rename.");
            return;
        } else if (index >= settings.SavedAreas.length) {
            return;
        }

        let newName = prompt("Enter a new name");
        if (newName == null) {
            return;
        }

        settings.SavedAreas[index].name = newName;
        updateSavedAreasList();
    }

    async function scanArea(): Promise<void> {
        let index = -1;
        let nodes = $("input[name=_wmewalScanArea]", "#_wmewalOptionsSavedAreas");
        for (let ix = 0; ix < nodes.length; ix++) {
            if ((<HTMLInputElement> nodes[ix]).checked) {
                index = ix;
                break;
            }
        }

        if (index === -1) {
            alert("Please select an area to scan.");
            return;
        } else if (index >= settings.SavedAreas.length) {
            return;
        }

        areaToScan = <OpenLayers.Geometry.Collection> settings.SavedAreas[index].geometry;

        await scan(settings.SavedAreas[index].name);
    }

    async function scan(name: string): Promise<void> {
        getBounds();

        if (topLeft == null || bottomRight == null) {
            alert("No bounds");
            return;
        }

        let anyActivePlugins = false;
        needSegments = false;
        needVenues = false;
        let needMapComments = false;
        for (let ix = 0; ix < plugins.length; ix++) {
            if (plugins[ix].Active) {
                anyActivePlugins = true;
                needSegments = needSegments || plugins[ix].SupportsSegments;
                needVenues = needVenues || plugins[ix].SupportsVenues;
                if (plugins[ix].Title === "Map Comments") {
                    needMapComments = true;
                }
            }
        }

        if (!anyActivePlugins) {
            alert("Please make sure at least one plug-in is active.");
            return;
        }

        areaName = name;

        // segments = [];
        // venues = [];

        let allOk = true;

        pb = new ProgressBar("#wal-progressBar");
        pb.update(0);
        pb.show();

        showPBInfo(true);

        for (let ix = 0; ix < plugins.length; ix++) {
            if (plugins[ix].Active) {
                info("Initializing plugin " + plugins[ix].Title);
                allOk = allOk && plugins[ix].ScanStarted();
            }
        }

        info("");

        if (!allOk) {
            pb.hide();
            showPBInfo(false);
            return;
        }

        info("Please don't touch anything during the scan");

        $("#_wmewalCancel").removeAttr("disabled");

        // Alert user if they try to leave the page before scan is finished
        window.addEventListener('beforeunload', alertBeforeClose);
        //Cleanup when closing page
        window.addEventListener('unload', cancel);

        // Save current state
        currentCenter = W.map.getCenter();
        currentZoom = W.map.zoom;
        layerToggle = [];

        let groups = $("div.layer-switcher li.group");
        groups.each(function (ix, g) {
            let groupToggle = $(g).find("wz-toggle-switch");
            switch ($(groupToggle).attr("id")) {
                case "layer-switcher-group_places":
                    if (needVenues) {
                        if (!$(groupToggle).prop("checked")) {
                            $(groupToggle).trigger("click");
                            layerToggle.push($(groupToggle).attr("id"));
                        }
                        // Loop through each child in the group
                        $(g).find("ul > li > wz-checkbox").each(function (ixChild, c) {
                            switch ($(c).attr("id")) {
                                case "layer-switcher-item_venues":
                                case "layer-switcher-item_residential_places":
                                case "layer-switcher-item_parking_places":
                                    if (!$(c).prop("checked")) {
                                        $(c).trigger("click");
                                        layerToggle.push($(c).attr("id"));
                                    }
                                    break;
                                default:
                                    if ($(c).prop("checked")) {
                                        $(c).trigger("click");
                                        layerToggle.push($(c).attr("id"));
                                    }
                                    break;
                            }
                        });
                    } else {
                        if ($(groupToggle).prop("checked")) {
                            $(groupToggle).trigger("click");
                            layerToggle.push($(groupToggle).attr("id"));
                        }
                    }
                    break;
                case "layer-switcher-group_road":
                    if ($(groupToggle).prop("checked")) {
                        $(groupToggle).trigger("click");
                        layerToggle.push($(groupToggle).attr("id"));
                    }
                    break;
                case "layer-switcher-group_display":
                    if (needMapComments) {
                        if (!$(groupToggle).prop("checked")) {
                            $(groupToggle).trigger("click");
                            layerToggle.push($(groupToggle).attr("id"));
                        }
                        // Loop through each child in the group
                        $(g).find("ul > li > wz-checkbox").each(function (ixChild, c) {
                            switch ($(c).attr("id")) {
                                case "layer-switcher-item_map_comments":
                                    if (!$(c).prop("checked")) {
                                        $(c).trigger("click");
                                        layerToggle.push($(c).attr("id"));
                                    }
                                    break;
                                default:
                                    if ($(c).prop("checked")) {
                                        $(c).trigger("click");
                                        layerToggle.push($(c).attr("id"));
                                    }
                                    break;
                            }
                        });
                    } else {
                        if ($(groupToggle).prop("checked")) {
                            $(groupToggle).trigger("click");
                            layerToggle.push($(groupToggle).attr("id"));
                        }
                    }
                    break;
                default:
                    if ($(groupToggle).prop("checked")) {
                        $(groupToggle).trigger("click");
                        layerToggle.push($(groupToggle).attr("id"));
                    }
                    break;
            }
        });

        // Reload road layers
        if (!W.model.actionManager.canUndo()) {
            for (let ix = 0; ix < W.map.roadLayers.length; ix++) {
                W.map.roadLayers[ix].redraw(true);
            }
            if (typeof W.controller.reloadData === "function") {
                W.controller.reloadData();
            } else {
                W.controller.reload();
            }
        }

        let minZoomLevel = 0;
        for (let ix = 0; ix < plugins.length; ix++) {
            if (plugins[ix].Active) {
                if (plugins[ix].MinimumZoomLevel > minZoomLevel) {
                    minZoomLevel = plugins[ix].MinimumZoomLevel;
                }
            }
        }

        zoomLevel = minZoomLevel;
        WALMap.zoomTo(zoomLevel);

        let extent = W.map.getExtent();
        height = extent.getHeight();
        width = extent.getWidth();

        // Figure out how many horizontal and vertical viewports there are
        let horizontalSpan = Math.floor((bottomRight.x - topLeft.x) / width) + 2;
        let verticalSpan = Math.floor((topLeft.y - bottomRight.y) / height) + 2;
        totalViewports = horizontalSpan * verticalSpan + 1;
        countViewports = 0;

        log("Debug","Horizontal span = " + horizontalSpan.toString());
        log("Debug","Vertical span = " + verticalSpan.toString());
        log("Debug","Total viewports = " + totalViewports.toString());

        currentX = topLeft.x - width;
        currentY = topLeft.y;

        pb.show();

        cancelled = false;

        let status: ScanStatus;
        do {
            status = await moveToNextLocation();
            if (!cancelled && status === ScanStatus.Continue) {
                status = await scanExtent();
            }
            if (!cancelled && status === ScanStatus.Continue) {
                let progress = Math.floor(countViewports / totalViewports * 100);
                pb.update(progress);
            }
        } while (status === ScanStatus.Continue && !cancelled);

        if (status === ScanStatus.Abort || cancelled) {
            log("Debug","scan: scan aborted or canceled");
            cancel();
        } else {
            processComplete();
        }
    }

    async function moveToNextLocation(): Promise<ScanStatus> {
        let done = false;
        let inGeometry = false;

        do {
            if (areaToScan == null) {
                done = true;
            } else {
                countViewports += 1;
                log("Debug","Count viewports = " + countViewports.toString());

                currentX += width;
                if (currentX > bottomRight.x + width) {
                    log("Debug","New row");
                    // Start at next row
                    currentX = topLeft.x;
                    currentY -= height;
                    if (currentY < bottomRight.y - height) {
                        done = true;
                    }
                }

                if (!done) {
                    // Check to see if the new window would be within the boundaries of the original area
                    // Create a geometry object for the window boundaries
                    let points: Array<OpenLayers.Geometry.Point> = [];
                    points.push(new OpenLayers.Geometry.Point(currentX - (width / 2), currentY + (height / 2)));
                    points.push(new OpenLayers.Geometry.Point(currentX + (width / 2), currentY + (height / 2)));
                    points.push(new OpenLayers.Geometry.Point(currentX - (width / 2), currentY - (height / 2)));
                    points.push(new OpenLayers.Geometry.Point(currentX + (width / 2), currentY - (height / 2)));
                    let lr = new OpenLayers.Geometry.LinearRing(points);
                    let poly = new OpenLayers.Geometry.Polygon([lr]);
                    inGeometry = areaToScan && areaToScan.intersects(poly);
                }
            }

            if (!inGeometry) {
                let progress = Math.floor(countViewports / totalViewports * 100);
                pb.update(progress);
            }
        } while (!inGeometry && !done);

        if (!done) {
            return await moveMap();
        } else {
            return ScanStatus.Complete;
        }
    }

    async function moveMap(): Promise<ScanStatus> {
        let abort: boolean;
        let retry: boolean;

        do {
            abort = false;
            let retryCount = 0;
            do {
                retry = false;
                if (!cancelled) {
                    try {
                        W.map.setCenter(new OpenLayers.LonLat(currentX, currentY));
                        try {
                            await promiseTimeout(10000, onModelReadyWW());
                        } catch (e) {
                            log("warning","moveMap: Timer triggered after map not successfully moved within 10 seconds");
                            retryCount++;
                            retry = true;
                        }
                    } catch (e) {
                        log("warning","moveMap: Exception thrown trying to move map.  Will retry up to 5 times (with a 1-second delay).");
                        log("error",e);
                        await new Promise<void>(resolve => {
                            setTimeout(function () {
                                resolve();
                            }, 1000);
                        });
                        retry = true;
                        retryCount++;
                    }
                }
            } while (retry && retryCount < 5);

            if (retry) {
                abort = !confirm("Exceeded maximum allowable attempts to move the map. Do you want to continue trying?");
            }
        } while (retry && !abort);

        if (abort) {
            return ScanStatus.Abort;
        } else {
            return ScanStatus.Continue;
        }
    }

    async function scanExtent(): Promise<ScanStatus> {
        let keepScanning = true;
        if (!cancelled) {
            let extentSegments: Array<WazeNS.Model.Object.Segment> = [];
            let extentVenues: Array<WazeNS.Model.Object.Venue> = [];

            // Check to see if the current extent is completely within the area being searched
            // let allIn = true;
            // let vertices = W.map.getExtent().toGeometry().getVertices();
            // for (let ix = 0; ix < vertices.length && allIn; ix++) {
            //     allIn = allIn && geoCollection.intersects(vertices[ix]);
            // }
            // log("Debug","Extent is " + (!allIn ? "NOT " : "") + "entirely within area");

            if (needSegments) { // && segments != null) {
                log("Debug","scanExtent: Collecting segments");
                for (let seg in W.model.segments.objects) {
                    // if (segments.indexOf(seg) === -1) {
                        let segment = W.model.segments.getObjectById(parseInt(seg));
                        if (segment != null) {
                            // segments.push(seg);
                            extentSegments.push(segment);
                        }
                    // }
                }
                log("Debug",`scanExtent: Done collecting segments (${extentSegments.length})`);
            }

            if (needVenues) { //} && venues != null) {
                log("Debug","scanExtent: Collecting venues");
                for (let ven in W.model.venues.objects) {
                    // if (venues.indexOf(ven) === -1) {
                        let venue = W.model.venues.getObjectById(ven);
                        if (venue != null) {
                            // venues.push(ven);
                            extentVenues.push(venue);
                        }
                    // }
                }
                log("Debug",`scanExtent: Done collecting venues (${extentVenues.length})`);
            }

            let promises: Array<Promise<void>> = [];
            for (let ix = 0; ix < plugins.length; ix++) {
                if (plugins[ix].Active && !cancelled) {
                    log("Debug","scanExtent: Calling plugin " + plugins[ix].Title);
                    promises.push(plugins[ix].ScanExtent(extentSegments, extentVenues));
                }
            }

            log("Debug","scanExtent: Awaiting all promises");
            let pluginResults = await Promise.allSettled(promises);
            let anyErrors = false;
            for (let ix = 0; ix < pluginResults.length; ix++) {
                log("Debug",`scanExtent: Plugin ${ix}: ${pluginResults[ix].status}`);
                if (pluginResults[ix].status === "rejected") {
                    log("error",(<PromiseRejectedResult>pluginResults[ix]).reason);
                    anyErrors = true;
                }
            }

            if (anyErrors) {
                keepScanning = confirm("An error occurred in the one of the plugins. Do you want to continue?");
            }
        }

        if (keepScanning) {
            return ScanStatus.Continue;
        } else {
            return ScanStatus.Abort;
        }
    }

    function log(level: string, message: any): void {
        let t = new Date();
        switch (level.toLocaleLowerCase()) {
            case "debug":
            case "verbose":
                console.debug(`${scrName} ${t.toISOString()}: ${message}`);
                break;
            case "info":
            case "information":
                console.info(`${scrName} ${t.toISOString()}: ${message}`);
                break;
            case "warning":
            case "warn":
                console.warn(`${scrName} ${t.toISOString()}: ${message}`);
                break;
            case "error":
                console.error(`${scrName} ${t.toISOString()}: ${message}`);
                break;
            case "log":
                console.log(`${scrName} ${t.toISOString()}: ${message}`);
                break;
            default:
                break;
        }
    }

    function parseOutputTo(outputTo: string): OutputTo {
        let ot: OutputTo;
        switch (outputTo.toLowerCase()) {
            case "csv":
                ot = OutputTo.CSV;
                break;
            case "tab":
                ot = OutputTo.Tab;
                break;
            case "both":
                ot = OutputTo.CSV | OutputTo.Tab;
                break;
            default:
                break;
        }
        return ot;
    }

    export function WazeRoadTypeToRoadTypeBitmask(roadType: number): RoadType {
        switch (roadType) {
            case 1:
                return RoadType.Street;
            case 2:
                return RoadType.PrimaryStreet;
            case 3:
                return RoadType.Freeway;
            case 4:
                return RoadType.Ramp;
            case 5:
                return RoadType.WalkingTrail;
            case 6:
                return RoadType.MajorHighway;
            case 7:
                return RoadType.MinorHighway;
            case 8:
                return RoadType.Unpaved;
            case 10:
                return RoadType.PedestrianBoardwalk;
            case 15:
                return RoadType.Ferry;
            case 16:
                return RoadType.Stairway;
            case 17:
                return RoadType.PrivateRoad;
            case 18:
                return RoadType.Railroad;
            case 19:
                return RoadType.RunwayTaxiway;
            case 20:
                return RoadType.ParkingLotRoad;
            case 22:
                return RoadType.Alley;
            default:
                return 0;
        }
    }

    export function RoadTypeBitmaskToWazeRoadType(roadType: RoadType): number {
        switch (roadType) {
            case RoadType.Street:
                return 1;
            case RoadType.PrimaryStreet:
                return 2;
            case RoadType.Freeway:
                return 3;
            case RoadType.Ramp:
                return 4;
            case RoadType.WalkingTrail:
                return 5;
            case RoadType.MajorHighway:
                return 6;
            case RoadType.MinorHighway:
                return 7;
            case RoadType.Unpaved:
                return 8;
            case RoadType.PedestrianBoardwalk:
                return 10;
            case RoadType.Ferry:
                return 15;
            case RoadType.Stairway:
                return 16;
            case RoadType.PrivateRoad:
                return 17;
            case RoadType.Railroad:
                return 18;
            case RoadType.RunwayTaxiway:
                return 19;
            case RoadType.ParkingLotRoad:
                return 20;
            case RoadType.Alley:
                return 22;
            default:
                return 0;
        }
    }

    export function WazeRoadTypeToRoutingPreference(roadType: number): number {
        switch (roadType) {
            case 1:
                return 1;
            case 2:
                return 2;
            case 7:
                return 3;
            case 6:
                return 4;
            case 3:
                return 5;
            default:
                return 0;
        }
    }

    export function TranslateRoadType(wazeRoadType: number): string {
        return I18n.t("segment.road_types." + wazeRoadType.toString());
    }

    export function GenerateBasePL(lat: number, lon: number, zoom: number): string {
        return "https://www.waze.com/editor/?env=" + W.app.getAppRegionCode() + "&lon=" + lon + "&lat=" + lat + "&zoom=" + zoom;
    }

    export function CompareVersions(v1: string, v2: string) : number {
        let v1Parts = v1.split(".");
        let v2Parts = v2.split(".");

        for (; v1Parts.length < v2Parts.length;) {
            v1Parts.push(".0");
        }
        for (; v2Parts.length < v1Parts.length;) {
            v2Parts.push(".0");
        }

        for (let ix = 0; ix < v1Parts.length; ix++) {
            let v1Element = parseInt(v1Parts[ix]);
            let v2Element = parseInt(v2Parts[ix]);
            if (v1Element < v2Element) {
                return -1;
            }
            else if (v1Element > v2Element) {
                return 1;
            }
        }

        return 0;
    }

    export function IsAtMinimumVersion(version: string): boolean {
        return (CompareVersions(getVersion(), version) >= 0);
    }

    function getVersion(): string {
        let version = GM_info.script.version;
        if (version.startsWith("v")) {
            version = version.substring(1);
        }
        return version;
    }

    function promiseTimeout(ms: number, promise: Promise<any>) : Promise<any> {

        // Create a promise that rejects in <ms> milliseconds
        let timeout = new Promise((resolve, reject) => {
          let id = setTimeout(() => {
            clearTimeout(id);
            reject()
          }, ms)
        });

        // Returns a race between our timeout and the passed in promise
        return Promise.race([
          promise,
          timeout
        ]);
      }

    // Copyright (c) 2013 Pieroxy <pieroxy@pieroxy.net>
    // This work is free. You can redistribute it and/or modify it
    // under the terms of the WTFPL, Version 2
    // For more information see LICENSE.txt or http://www.wtfpl.net/
    //
    // For more information, the home page:
    // http://pieroxy.net/blog/pages/lz-string/testing.html
    //
    // LZ-based compression algorithm, version 1.4.4

    /* tslint:disable */
    export let LZString = (function () {
        // private property
        var f = String.fromCharCode;
        var keyStrBase64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";
        var keyStrUriSafe = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+-$";
        var baseReverseDic = {};
        function getBaseValue(alphabet, character) {
            if (!baseReverseDic[alphabet]) {
                baseReverseDic[alphabet] = {};
                for (var i = 0; i < alphabet.length; i++) {
                    baseReverseDic[alphabet][alphabet.charAt(i)] = i;
                }
            }
            return baseReverseDic[alphabet][character];
        }
        var LZString = {
            compressToBase64: function (input) {
                if (input == null)
                    return "";
                var res = LZString._compress(input, 6, function (a) { return keyStrBase64.charAt(a); });
                switch (res.length % 4) {
                    default: // When could this happen ?
                    case 0: return res;
                    case 1: return res + "===";
                    case 2: return res + "==";
                    case 3: return res + "=";
                }
            },
            decompressFromBase64: function (input) {
                if (input == null)
                    return "";
                if (input == "")
                    return null;
                return LZString._decompress(input.length, 32, function (index) { return getBaseValue(keyStrBase64, input.charAt(index)); });
            },
            compressToUTF16: function (input) {
                if (input == null)
                    return "";
                return LZString._compress(input, 15, function (a) { return f(a + 32); }) + " ";
            },
            decompressFromUTF16: function (compressed) {
                if (compressed == null)
                    return "";
                if (compressed == "")
                    return null;
                return LZString._decompress(compressed.length, 16384, function (index) { return compressed.charCodeAt(index) - 32; });
            },
            //compress into uint8array (UCS-2 big endian format)
            compressToUint8Array: function (uncompressed) {
                var compressed = LZString.compress(uncompressed);
                var buf = new Uint8Array(compressed.length * 2); // 2 bytes per character
                for (var i = 0, TotalLen = compressed.length; i < TotalLen; i++) {
                    var current_value = compressed.charCodeAt(i);
                    buf[i * 2] = current_value >>> 8;
                    buf[i * 2 + 1] = current_value % 256;
                }
                return buf;
            },
            //decompress from uint8array (UCS-2 big endian format)
            decompressFromUint8Array: function (compressed) {
                if (compressed == null || compressed === undefined) {
                    return LZString.decompress(compressed);
                }
                else {
                    var buf = new Array(compressed.length / 2); // 2 bytes per character
                    for (var i = 0, TotalLen = buf.length; i < TotalLen; i++) {
                        buf[i] = compressed[i * 2] * 256 + compressed[i * 2 + 1];
                    }
                    var result_1 = [];
                    buf.forEach(function (c) {
                        result_1.push(f(c));
                    });
                    return LZString.decompress(result_1.join(''));
                }
            },
            //compress into a string that is already URI encoded
            compressToEncodedURIComponent: function (input) {
                if (input == null)
                    return "";
                return LZString._compress(input, 6, function (a) { return keyStrUriSafe.charAt(a); });
            },
            //decompress from an output of compressToEncodedURIComponent
            decompressFromEncodedURIComponent: function (input) {
                if (input == null)
                    return "";
                if (input == "")
                    return null;
                input = input.replace(/ /g, "+");
                return LZString._decompress(input.length, 32, function (index) { return getBaseValue(keyStrUriSafe, input.charAt(index)); });
            },
            compress: function (uncompressed) {
                return LZString._compress(uncompressed, 16, function (a) { return f(a); });
            },
            _compress: function (uncompressed, bitsPerChar, getCharFromInt) {
                if (uncompressed == null)
                    return "";
                var i, value, context_dictionary = {}, context_dictionaryToCreate = {}, context_c = "", context_wc = "", context_w = "", context_enlargeIn = 2, // Compensate for the first entry which should not count
                context_dictSize = 3, context_numBits = 2, context_data = [], context_data_val = 0, context_data_position = 0, ii;
                for (var ii_1 = 0; ii_1 < uncompressed.length; ii_1 += 1) {
                    context_c = uncompressed.charAt(ii_1);
                    if (!Object.prototype.hasOwnProperty.call(context_dictionary, context_c)) {
                        context_dictionary[context_c] = context_dictSize++;
                        context_dictionaryToCreate[context_c] = true;
                    }
                    context_wc = context_w + context_c;
                    if (Object.prototype.hasOwnProperty.call(context_dictionary, context_wc)) {
                        context_w = context_wc;
                    }
                    else {
                        if (Object.prototype.hasOwnProperty.call(context_dictionaryToCreate, context_w)) {
                            if (context_w.charCodeAt(0) < 256) {
                                for (var i_1 = 0; i_1 < context_numBits; i_1++) {
                                    context_data_val = (context_data_val << 1);
                                    if (context_data_position == bitsPerChar - 1) {
                                        context_data_position = 0;
                                        context_data.push(getCharFromInt(context_data_val));
                                        context_data_val = 0;
                                    }
                                    else {
                                        context_data_position++;
                                    }
                                }
                                value = context_w.charCodeAt(0);
                                for (var i_2 = 0; i_2 < 8; i_2++) {
                                    context_data_val = (context_data_val << 1) | (value & 1);
                                    if (context_data_position == bitsPerChar - 1) {
                                        context_data_position = 0;
                                        context_data.push(getCharFromInt(context_data_val));
                                        context_data_val = 0;
                                    }
                                    else {
                                        context_data_position++;
                                    }
                                    value = value >> 1;
                                }
                            }
                            else {
                                value = 1;
                                for (var i_3 = 0; i_3 < context_numBits; i_3++) {
                                    context_data_val = (context_data_val << 1) | value;
                                    if (context_data_position == bitsPerChar - 1) {
                                        context_data_position = 0;
                                        context_data.push(getCharFromInt(context_data_val));
                                        context_data_val = 0;
                                    }
                                    else {
                                        context_data_position++;
                                    }
                                    value = 0;
                                }
                                value = context_w.charCodeAt(0);
                                for (var i_4 = 0; i_4 < 16; i_4++) {
                                    context_data_val = (context_data_val << 1) | (value & 1);
                                    if (context_data_position == bitsPerChar - 1) {
                                        context_data_position = 0;
                                        context_data.push(getCharFromInt(context_data_val));
                                        context_data_val = 0;
                                    }
                                    else {
                                        context_data_position++;
                                    }
                                    value = value >> 1;
                                }
                            }
                            context_enlargeIn--;
                            if (context_enlargeIn == 0) {
                                context_enlargeIn = Math.pow(2, context_numBits);
                                context_numBits++;
                            }
                            delete context_dictionaryToCreate[context_w];
                        }
                        else {
                            value = context_dictionary[context_w];
                            for (var i_5 = 0; i_5 < context_numBits; i_5++) {
                                context_data_val = (context_data_val << 1) | (value & 1);
                                if (context_data_position == bitsPerChar - 1) {
                                    context_data_position = 0;
                                    context_data.push(getCharFromInt(context_data_val));
                                    context_data_val = 0;
                                }
                                else {
                                    context_data_position++;
                                }
                                value = value >> 1;
                            }
                        }
                        context_enlargeIn--;
                        if (context_enlargeIn == 0) {
                            context_enlargeIn = Math.pow(2, context_numBits);
                            context_numBits++;
                        }
                        // Add wc to the dictionary.
                        context_dictionary[context_wc] = context_dictSize++;
                        context_w = String(context_c);
                    }
                }
                // Output the code for w.
                if (context_w !== "") {
                    if (Object.prototype.hasOwnProperty.call(context_dictionaryToCreate, context_w)) {
                        if (context_w.charCodeAt(0) < 256) {
                            for (var i_6 = 0; i_6 < context_numBits; i_6++) {
                                context_data_val = (context_data_val << 1);
                                if (context_data_position == bitsPerChar - 1) {
                                    context_data_position = 0;
                                    context_data.push(getCharFromInt(context_data_val));
                                    context_data_val = 0;
                                }
                                else {
                                    context_data_position++;
                                }
                            }
                            value = context_w.charCodeAt(0);
                            for (var i_7 = 0; i_7 < 8; i_7++) {
                                context_data_val = (context_data_val << 1) | (value & 1);
                                if (context_data_position == bitsPerChar - 1) {
                                    context_data_position = 0;
                                    context_data.push(getCharFromInt(context_data_val));
                                    context_data_val = 0;
                                }
                                else {
                                    context_data_position++;
                                }
                                value = value >> 1;
                            }
                        }
                        else {
                            value = 1;
                            for (var i_8 = 0; i_8 < context_numBits; i_8++) {
                                context_data_val = (context_data_val << 1) | value;
                                if (context_data_position == bitsPerChar - 1) {
                                    context_data_position = 0;
                                    context_data.push(getCharFromInt(context_data_val));
                                    context_data_val = 0;
                                }
                                else {
                                    context_data_position++;
                                }
                                value = 0;
                            }
                            value = context_w.charCodeAt(0);
                            for (var i_9 = 0; i_9 < 16; i_9++) {
                                context_data_val = (context_data_val << 1) | (value & 1);
                                if (context_data_position == bitsPerChar - 1) {
                                    context_data_position = 0;
                                    context_data.push(getCharFromInt(context_data_val));
                                    context_data_val = 0;
                                }
                                else {
                                    context_data_position++;
                                }
                                value = value >> 1;
                            }
                        }
                        context_enlargeIn--;
                        if (context_enlargeIn == 0) {
                            context_enlargeIn = Math.pow(2, context_numBits);
                            context_numBits++;
                        }
                        delete context_dictionaryToCreate[context_w];
                    }
                    else {
                        value = context_dictionary[context_w];
                        for (var i_10 = 0; i_10 < context_numBits; i_10++) {
                            context_data_val = (context_data_val << 1) | (value & 1);
                            if (context_data_position == bitsPerChar - 1) {
                                context_data_position = 0;
                                context_data.push(getCharFromInt(context_data_val));
                                context_data_val = 0;
                            }
                            else {
                                context_data_position++;
                            }
                            value = value >> 1;
                        }
                    }
                    context_enlargeIn--;
                    if (context_enlargeIn == 0) {
                        context_enlargeIn = Math.pow(2, context_numBits);
                        context_numBits++;
                    }
                }
                // Mark the end of the stream
                value = 2;
                for (var i_11 = 0; i_11 < context_numBits; i_11++) {
                    context_data_val = (context_data_val << 1) | (value & 1);
                    if (context_data_position == bitsPerChar - 1) {
                        context_data_position = 0;
                        context_data.push(getCharFromInt(context_data_val));
                        context_data_val = 0;
                    }
                    else {
                        context_data_position++;
                    }
                    value = value >> 1;
                }
                // Flush the last char
                while (true) {
                    context_data_val = (context_data_val << 1);
                    if (context_data_position == bitsPerChar - 1) {
                        context_data.push(getCharFromInt(context_data_val));
                        break;
                    }
                    else
                        context_data_position++;
                }
                return context_data.join('');
            },
            decompress: function (compressed) {
                if (compressed == null)
                    return "";
                if (compressed == "")
                    return null;
                return LZString._decompress(compressed.length, 32768, function (index) { return compressed.charCodeAt(index); });
            },
            _decompress: function (length, resetValue, getNextValue) {
                var dictionary = [], next, enlargeIn = 4, dictSize = 4, numBits = 3, entry = "", result = [], i, w, bits, resb, maxpower, power, c, data = { val: getNextValue(0), position: resetValue, index: 1 };
                for (var i_12 = 0; i_12 < 3; i_12 += 1) {
                    dictionary[i_12] = i_12;
                }
                bits = 0;
                maxpower = Math.pow(2, 2);
                power = 1;
                while (power != maxpower) {
                    resb = data.val & data.position;
                    data.position >>= 1;
                    if (data.position == 0) {
                        data.position = resetValue;
                        data.val = getNextValue(data.index++);
                    }
                    bits |= (resb > 0 ? 1 : 0) * power;
                    power <<= 1;
                }
                switch (next = bits) {
                    case 0:
                        bits = 0;
                        maxpower = Math.pow(2, 8);
                        power = 1;
                        while (power != maxpower) {
                            resb = data.val & data.position;
                            data.position >>= 1;
                            if (data.position == 0) {
                                data.position = resetValue;
                                data.val = getNextValue(data.index++);
                            }
                            bits |= (resb > 0 ? 1 : 0) * power;
                            power <<= 1;
                        }
                        c = f(bits);
                        break;
                    case 1:
                        bits = 0;
                        maxpower = Math.pow(2, 16);
                        power = 1;
                        while (power != maxpower) {
                            resb = data.val & data.position;
                            data.position >>= 1;
                            if (data.position == 0) {
                                data.position = resetValue;
                                data.val = getNextValue(data.index++);
                            }
                            bits |= (resb > 0 ? 1 : 0) * power;
                            power <<= 1;
                        }
                        c = f(bits);
                        break;
                    case 2:
                        return "";
                }
                dictionary[3] = c;
                w = c;
                result.push(c);
                while (true) {
                    if (data.index > length) {
                        return "";
                    }
                    bits = 0;
                    maxpower = Math.pow(2, numBits);
                    power = 1;
                    while (power != maxpower) {
                        resb = data.val & data.position;
                        data.position >>= 1;
                        if (data.position == 0) {
                            data.position = resetValue;
                            data.val = getNextValue(data.index++);
                        }
                        bits |= (resb > 0 ? 1 : 0) * power;
                        power <<= 1;
                    }
                    switch (c = bits) {
                        case 0:
                            bits = 0;
                            maxpower = Math.pow(2, 8);
                            power = 1;
                            while (power != maxpower) {
                                resb = data.val & data.position;
                                data.position >>= 1;
                                if (data.position == 0) {
                                    data.position = resetValue;
                                    data.val = getNextValue(data.index++);
                                }
                                bits |= (resb > 0 ? 1 : 0) * power;
                                power <<= 1;
                            }
                            dictionary[dictSize++] = f(bits);
                            c = dictSize - 1;
                            enlargeIn--;
                            break;
                        case 1:
                            bits = 0;
                            maxpower = Math.pow(2, 16);
                            power = 1;
                            while (power != maxpower) {
                                resb = data.val & data.position;
                                data.position >>= 1;
                                if (data.position == 0) {
                                    data.position = resetValue;
                                    data.val = getNextValue(data.index++);
                                }
                                bits |= (resb > 0 ? 1 : 0) * power;
                                power <<= 1;
                            }
                            dictionary[dictSize++] = f(bits);
                            c = dictSize - 1;
                            enlargeIn--;
                            break;
                        case 2:
                            return result.join('');
                    }
                    if (enlargeIn == 0) {
                        enlargeIn = Math.pow(2, numBits);
                        numBits++;
                    }
                    if (dictionary[c]) {
                        entry = dictionary[c];
                    }
                    else {
                        if (c === dictSize) {
                            entry = w + w.charAt(0);
                        }
                        else {
                            return null;
                        }
                    }
                    result.push(entry);
                    // Add w+entry[0] to the dictionary.
                    dictionary[dictSize++] = w + entry.charAt(0);
                    enlargeIn--;
                    w = entry;
                    if (enlargeIn == 0) {
                        enlargeIn = Math.pow(2, numBits);
                        numBits++;
                    }
                }
            }
        };
        return LZString;
    })();

    /* tslint:enable */
    setTimeout(WideAngleLens, 1000);
}
