// ==UserScript==
// @name         Youtube Auto-translate Canceler
// @namespace    https://github.com/VasariRulez/YoutubeAutotranslateCanceler
// @version      0.69.5
// @description  Remove auto-translated youtube titles
// @author       Pierre Couy
// @match        https://www.youtube.com/*
// @grant        GM.setValue
// @grant        GM.getValue
// @grant        GM.deleteValue
// ==/UserScript==

// Configurations
// How many milliseconds between each check. Higher value means more stress on browser.
const MAIN_POLLING_INTERVAL = 1000;
// How many milliseconds between each check if description has been changed or not by method of clicking the "show more" or "show less" button. Lightweight, can set to a low value.
const DESCRIPTION_POLLING_INTERVAL = 200;

(async () => {
    'use strict';
	var useTrusted = false;
    //i am confused, but this might help?
    if (window.trustedTypes && window.trustedTypes.createPolicy) {
        window.trustedTypes.createPolicy('default', {
            createHTML: (string, sink) => string
        });
        useTrusted = true;
    }

    /*
    Get a YouTube Data v3 API key from https://console.developers.google.com/apis/library/youtube.googleapis.com?q=YoutubeData
    */
    var NO_API_KEY = false;
    var api_key_awaited = await GM.getValue("api_key");
    if (api_key_awaited === undefined || api_key_awaited === null || api_key_awaited === "") {
        await GM.setValue("api_key", prompt("Enter your API key. Go to https://developers.google.com/youtube/v3/getting-started to know how to obtain an API key, then go to https://console.developers.google.com/apis/api/youtube.googleapis.com/ in order to enable Youtube Data API for your key."));
    }

    api_key_awaited = await GM.getValue("api_key");
    if (api_key_awaited === undefined || api_key_awaited === null || api_key_awaited === "") {
        NO_API_KEY = true; // Resets after page reload, still allows local title to be replaced
        console.log("NO API KEY PRESENT");
    }
    const API_KEY = await GM.getValue("api_key");
    var API_KEY_VALID = false;
    console.log(API_KEY);

    var url_template = "https://www.googleapis.com/youtube/v3/videos?part=snippet&id={IDs}&key=" + API_KEY;

    // Caches can grow big with long tab sessions. Not sure the real impact but refreshing a YT tab from time to time might help.
    var cachedTitles = {} // Dictionary(id, title): Cache of API fetches, survives only Youtube Autoplay

    var currentLocation; // String: Current page URL
    var changedDescription; // Bool: Changed description
    var alreadyChanged; // List(string): Links already changed
    var cachedDescription; // String: Cached description to use for updating desc when it's been changed once
    var cachedTitle; // String: Cached title to revert changes done by YT after title has already been updated
    var noDescription; // Bool: For when the video doesn't even have a description

    function getVideoID(a) {
        while (a.tagName != "A") {
            a = a.parentNode;
        }
        var href = a.href;
        if (href.includes("short")) {
            var tmp = href.split('/')[4];
        } else {
            var tmp = href.split('v=')[1];
        }
        return tmp.split('&')[0];
    }

    function resetChanged() {
        console.log(" --- Page Change detected! --- ");
        currentLocation = document.title;
        changedDescription = false;
        noDescription = false;
        alreadyChanged = [];
    }
    resetChanged();

    function changeTitles() {
        if (currentLocation !== document.title) resetChanged();

        if (NO_API_KEY) {
            return;
        }

        var APIcallIDs;

        // REFERENCED VIDEO TITLES - find video link elements in the page that have not yet been changed
        var links = Array.prototype.slice.call(document.getElementsByTagName("a")).filter(a => {
            return (a.id == 'video-title-link' || a.id == 'video-title') &&
                !(
                    a.classList.contains("ytd-video-preview")
                    || a.href.includes("list=")
                    || a.href.includes("googleadservices") // Here we ignore googleadservices links, since they are not videos and have different structure
            ) &&
                alreadyChanged.indexOf(a) == -1;
        });

        var spans = Array.prototype.slice.call(document.getElementsByTagName("span")).filter(a => {
            return (
                    a.id == 'video-title' 
                    // I don't remember why I added this line, maybe it was for a specific temporary layout change but i think it was for the homepage video titles
                    || (a.className == 'yt-core-attributed-string yt-core-attributed-string--white-space-pre-wrap') && a.parentNode.className == 'yt-lockup-metadata-view-model-wiz__title'
                ) &&
                !(
                    a.parentNode.href?.includes("list=") 
                    || a.classList.contains("ytd-radio-renderer") 
                    || a.classList.contains("ytd-playlist-renderer")
                    || a.parentNode.href?.includes("googleadservices") // Here we ignore googleadservices links, since they are not videos and have different structure
                ) &&
                alreadyChanged.indexOf(a) == -1;
        });

        links = links.concat(spans).slice(0, 30);

        // MAIN VIDEO DESCRIPTION - request to load original video description
        var mainVidID = "";
        if (!changedDescription && window.location.href.includes("/watch")) {
            mainVidID = window.location.href.split('v=')[1].split('&')[0];
            cachedDescription = "";
        }

        if (mainVidID != "" || links.length > 0) { // Initiate API request

            console.log("Checking " + (mainVidID != "" ? "main video and " : "") + links.length + " video titles!");

            // Get all videoIDs to put in the API request
            var IDs = links.map(a => getVideoID(a));
            var APIFetchIDs = IDs.filter(id => cachedTitles[id] === undefined);
            var requestUrl = url_template.replace("{IDs}", (mainVidID != "" ? (mainVidID + ",") : "") + APIFetchIDs.join(','));

            // Issue API request
            var xhr = new XMLHttpRequest();
            xhr.onreadystatechange = function() {
                if (xhr.readyState === 4) { // Success
                    var data = JSON.parse(xhr.responseText);

                    if (data.kind == "youtube#videoListResponse") {
                        API_KEY_VALID = true;

                        data = data.items;

                        if (mainVidID != "") {
                            replaceVideoDesc(data);
                        }

                        // Create dictionary for all IDs and their original titles
                        data = data.forEach(v => {
                            cachedTitles[v.id] = v.snippet.title;
                        });

                        // Change all previously found link elements
                        for (var i = 0; i < links.length; i++) {
                            var curID = getVideoID(links[i]);
                            if (curID !== IDs[i]) { // Can happen when Youtube was still loading when script was invoked
                                console.log("YouTube was too slow again...");
                                changedDescription = false; // Might not have been loaded aswell - fixes rare errors
                            }
                            if (cachedTitles[curID] !== undefined) {
                                var originalTitle = cachedTitles[curID];
                                var pageTitle = links[i].innerText.trim();
                                if (pageTitle != originalTitle.replace(/\s{2,}/g, ' ')) {
                                    console.log("'" + pageTitle + "' --> '" + originalTitle + "'");
                                    if (links[i].tagName == "SPAN") {
                                        links[i].innerText = originalTitle;
                                    } else {
                                        links[i].title = originalTitle; // This sets the tooltip title on mouseover
                                        links[i].querySelector("yt-formatted-string").innerText = originalTitle;
                                    }
                                }
                                alreadyChanged.push(links[i]);
                            }
                        }
                    } else {
                        console.log("API Request Failed!");
                        console.log(requestUrl);
                        console.log(data);

                        // This ensures that occasional fails don't stall the script
                        // But if the first query is a fail then it won't try repeatedly
                        NO_API_KEY = !API_KEY_VALID;
                        if (NO_API_KEY) {
                            GM_setValue('api_key', '');
                            console.log("API Key Fail! Please Reload!");
                        }
                    }
                }
            };
            xhr.open('GET', requestUrl);
            xhr.send();

        }

        if (mainVidID == "" && changedDescription) {
            var pageTitle = document.querySelector("h1.style-scope.ytd-watch-metadata > yt-formatted-string.style-scope.ytd-watch-metadata"); // It was "h1.style-scope > yt-formatted-string" but a change in layout broke it
            if (pageTitle.attributes["is-empty"] != undefined) {
                pageTitle.removeAttribute("is-empty");
            }
            if (pageTitle.innerText.length != cachedTitle.length) {
                pageTitle.innerText = cachedTitle;
            }
        }
    }

    function linkify(inputText) {
        var replacedText, replacePattern1, replacePattern2, replacePattern3;

        //URLs starting with http://, https://, or ftp://
        replacePattern1 = /(\b(https?|ftp):\/\/[-A-Z0-9+&@#\/%?=~_|!:,.;]*[-A-Z0-9+&@#\/%=~_|])/gim;
        replacedText = inputText.replace(replacePattern1, '<a class="yt-simple-endpoint style-scope yt-formatted-string" spellcheck="false" href="$1">$1</a>');


        //URLs starting with "www." (without // before it, or it'd re-link the ones done above).
        replacePattern2 = /(^|[^\/])(www\.[\S]+(\b|$))/gim;
        replacedText = replacedText.replace(replacePattern2, '<a class="yt-simple-endpoint style-scope yt-formatted-string" spellcheck="false" href="http://$1">$1</a>');

        //Change email addresses to mailto:: links.
        replacePattern3 = /(([a-zA-Z0-9\-\_\.])+@[a-zA-Z\_]+?(\.[a-zA-Z]{2,6})+)/gim;
        replacedText = replacedText.replace(replacePattern3, '<a class="yt-simple-endpoint style-scope yt-formatted-string" spellcheck="false" href="mailto:$1">$1</a>');

        return replacedText;
    }

    function replaceVideoDesc(data) {
        var pageDescription = document.querySelector("#snippet yt-attributed-string > span");
        if(pageDescription == null){
            if(!document.querySelector("#description-placeholder").hidden){
                console.log("Oh, the video doesn't even have a description!");
                changedDescription = true;//this is kind of a lie, but does what we want it to, kind of
                noDescription = true;
                return;
            }
            console.log("Failed to find main video description on page!");
        }
        var videoDescription = data[0].snippet.description;
        var pageTitle = document.querySelector("h1.style-scope.ytd-watch-metadata > yt-formatted-string.style-scope.ytd-watch-metadata"); // It was "h1.style-scope > yt-formatted-string" but a change in layout broke it
        if (pageDescription != null && videoDescription != null) {
            // linkify replaces links correctly, but without redirect or other specific youtube stuff (no problem if missing)
            // Still critical, since it replaces ALL descriptions, even if it was not translated in the first place (no easy comparision possible)
            cachedDescription = linkify(videoDescription);
            if(useTrusted){
                pageDescription.innerHTML = window.trustedTypes.defaultPolicy.createHTML(cachedDescription);
            } else {
                pageDescription.innerHTML = cachedDescription;
            }
            pageDescription.attributes["changed"] = true;
            console.log("Reverting main video title '" + pageTitle.innerText + "' to '" + data[0].snippet.title + "'");
            pageTitle.innerText = data[0].snippet.title;
            pageTitle.title = data[0].snippet.title; // This sets the tooltip title on mouseover
            cachedTitle = data[0].snippet.title;
            // Just force a title update, screw youtube's title refresh logic
            pageTitle.removeAttribute("is-empty");
            document.title = data[0].snippet.title + " - Youtube";
            currentLocation = document.title;
            console.log("Reverting main video description!");
            changedDescription = true;
        } else {
            console.log("Failed to find main video description!");
        }
    }

    // Youtube fucked the description layout up by force reloading it when you click on the "show more" or "show less" button
    // So this is the workaround. 
    // --Ideally injecting directly the object that contains the description or modifying the behavior of these buttons is better.-- Done in addExpandButtonClickListener function below
    // Run separately from changeTitles() to be more responsive. Hopefully won't cause race condition. Shouldn't, but might.
    function replaceVideoDescCached() {
        if (!changedDescription || noDescription) {
            return;
        }
        var pageDescription = document.querySelector("#snippet yt-attributed-string > span");
        if (pageDescription != null && pageDescription.attributes["changed"] == undefined) {
            pageDescription.attributes["changed"] = true;
            if(useTrusted){
                pageDescription.innerHTML = window.trustedTypes.defaultPolicy.createHTML(cachedDescription);
            } else {
                pageDescription.innerHTML = cachedDescription;
            }
        }
    }

    // This function is called when the description is expanded by clicking the "show more" button or by clicking the description itself
    // It replaces the description with the cached description
    function replaceDescOnExpand(){
        if (!changedDescription || noDescription) {
            return;
        }
        var pageDescription = document.querySelector("div#description-inner > ytd-text-inline-expander#description-inline-expander > yt-attributed-string.style-scope.ytd-text-inline-expander");
        if (pageDescription != null && !pageDescription.hasAttribute("hidden")) {
            var desc = pageDescription.querySelector('span')
            if(desc != null){
                if(useTrusted){
                    desc.innerHTML = window.trustedTypes.defaultPolicy.createHTML(cachedDescription);
                } else {
                    desc.innerHTML = cachedDescription;
                }
            }
        }
    }

    // This function adds an event listener to the expand button, the description itself and the collapse button removing the old polling for the description
    function addExpandButtonClickListener() {
        // Check if the expand button is present on the page
        const expandButton = document.querySelector('tp-yt-paper-button#expand');
        if (!expandButton) {
            console.error("Expand button not found.");
            return;
        }
        // Check if the description is present on the page
        const descriptionInteraction = document.querySelector('div#description');
        if (!descriptionInteraction) {
            console.error("Description Interaction not found.");
            return;
        }
        // Check if the collapse button is present on the page
        const collapseButton = document.querySelector('tp-yt-paper-button#collapse');
        if (!collapseButton) {
            console.error("Collapse button not found.");
            return;
        }

         //If we have the buttons, we don't need to keep checking for them
        clearInterval(intervalID);

        // Add event listeners to the buttons and the description itself
        expandButton.addEventListener('click', replaceDescOnExpand);
        descriptionInteraction.addEventListener('click', replaceDescOnExpand);
        collapseButton.addEventListener('click', replaceVideoDescCached);

        console.log("Event listener added to the expand button.");
    }
    // Execute every seconds in case new content has been added to the page
    // DOM listener would be good if it was not for the fact that Youtube changes its DOM frequently
    setInterval(changeTitles, MAIN_POLLING_INTERVAL);

    // This is now done in addExpandButtonClickListener function
    //setInterval(replaceVideoDescCached, DESCRIPTION_POLLING_INTERVAL); 

    // Check every 5 seconds if the expand button, collapse button, and description are present on the page.
    // Add event listeners to them if they are present, otherwise retry in 5 seconds.
    // This polling was added because these elements were not present on the homepage, only on the video page.
    // With the new layout, these elements seems to be present on the homepage as well, but the polling is kept as a precaution.
    const intervalID = setInterval(addExpandButtonClickListener,5000); 
})();