#!/usr/bin/python3

import requests
import unicodedata
import re
import os
import os.path
import sys
import json
import codecs
from html.parser import HTMLParser
import xml.etree.ElementTree as ET
from email import utils
import datetime

START_DATE = datetime.datetime.today() - datetime.timedelta(days=20)

DEBUG = len(sys.argv) > 1
if DEBUG :
    LOG = open("aav.log", "w", encoding="UTF-8")

def slugify(value, allow_unicode=False):
    """
    Taken from https://github.com/django/django/blob/master/django/utils/text.py
    Convert to ASCII if 'allow_unicode' is False. Convert spaces or repeated
    dashes to single dashes. Remove characters that aren't alphanumerics,
    underscores, or hyphens. Convert to lowercase. Also strip leading and
    trailing whitespace, dashes, and underscores.
    """
    value = str(value)
    if allow_unicode:
        value = unicodedata.normalize('NFKC', value)
    else:
        value = unicodedata.normalize('NFKD', value).encode('ascii', 'ignore').decode('ascii')
    value = re.sub(r'[^\w\s-]', '', value.lower())
    return re.sub(r'[-\s]+', '-', value).strip('-_')


class AAVHTMLParser(HTMLParser):
    def __init__(self) :
        super().__init__()
        self.episodes = []

    def handle_starttag(self, tag, attrs):
        #if DEBUG :
        #    print(tag, attrs, file = LOG)
        if tag == "rps-playlist-action" :
            options = None
            for (name, value) in attrs :
                if name == "options" :
                    options = json.loads(value)
                    break
            if options is not None :
                self.episodes.append(options)
            elif DEBUG :
                print("No options found in tag rps-playlist-action");
 
    def handle_endtag(self, tag):
        pass

    def handle_data(self, data):
        pass

    def get_episodes(self) :
        return self.episodes

### MAIN ###
headers = { 'User-Agent' : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:146.0) Gecko/20100101 Firefox/146.0' }
r = requests.get("https://www.raiplaysound.it/programmi/adaltavoce", headers = headers)
text = r.content.decode('utf-8')
r.close()

parser = AAVHTMLParser()
parser.feed(text)
episodes = parser.get_episodes()
if DEBUG:
    print(episodes, file = LOG)


root = ET.Element("rss")
root.set("version", "2.0")
channel = ET.SubElement(root, "channel")
ET.SubElement(channel, "title").text = "Ad Alta Voce"
ET.SubElement(channel, "link").text = "https://www.raiplaysound.it/programmi/adaltavoce"
ET.SubElement(channel, "description").text = "Ad alta voce"
img = ET.SubElement(channel, "image")
ET.SubElement(img, "url").text = "https://www.raiplaysound.it/dl/img/2025/06/12/1749720160456_Ad%20alta%20voce-2048x2048.jpg"
ET.SubElement(img, "title").text = "Ad Alta Voce"
ET.SubElement(img, "link").text = "https://www.raiplaysound.it/programmi/adaltavoce"

for episode in episodes :
    r = requests.get("https://www.raiplaysound.it/" + episode['url'], headers = headers)
    puntata = r.json()
    r.close()

    if "downloadable_audio" in puntata :
        item = ET.SubElement(channel, "item")
        ET.SubElement(item, "title").text = puntata["episode_title"].strip()
        ET.SubElement(item, "link").text = "https://www.raiplaysound.it" + puntata["weblink"]
        if "description" in puntata :
            ET.SubElement(item, "description").text = puntata["description"]
        else:
            ET.SubElement(item, "description").text = puntata["episode_title"]

        pub_dttm = datetime.datetime.strptime(puntata["create_date"] + " " + puntata["create_time"], "%d-%m-%Y %H:%M")
        ET.SubElement(item, "pubDate").text = utils.format_datetime(pub_dttm)
        ET.SubElement(item, "guid").text = puntata["uniquename"]
        file = slugify(puntata["episode_title"].strip()) + ".mp3"
        if DEBUG:
            print("File: " + file)
                  
        enc = ET.SubElement(item, "enclosure")

        path = os.path.join("aav", file)
        if pub_dttm > START_DATE:
            if not os.path.exists(path) or os.path.getsize(path) == 0 :
                if DEBUG :
                    print("  downloading", puntata['downloadable_audio']['url'])
                os.system("python3 -m youtube_dl --audio-format mp3 -o \"" + path
                            + "\" \"" + puntata['downloadable_audio']['url'] + "\" 2>&1 >> ydl.log")
            enc.set("length", str(os.path.getsize(path)) if os.path.exists(path) else "0") # FIXME
            if DEBUG :
                print("  size: ", enc.get("length"))
        else:
            if DEBUG :
                print("  skip")
            enc.set("length", "0")
            if not os.path.exists(path) or os.path.getsize(path) != 0 :
                os.system("truncate --size=0 \"" + path + "\"");
        enc.set("url", "https://static.157.232.9.5.clients.your-server/aav/" + file)
        enc.set("type", "Content-Type: audio/mpeg")

tree = ET.ElementTree(root)
tree.write("ad-alta-voce.rss")
