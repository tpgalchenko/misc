import json

first = True

with open("chars.txt", "w", encoding="utf-8") as outfile :
    with open("chars.js", "r", encoding="utf-8") as infile :
        for line in infile :
            line = line.strip()
            if line.startswith('//') or line == 'const DATA = [' or line == '];' or len(line) == 0 :
                continue
            index = line.rfind(',')

            record = json.loads(line[0 : index])

            if first :
                first = False
            else :
                outfile.write(",")
            outfile.write(record['q'])
