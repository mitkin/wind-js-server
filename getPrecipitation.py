import json
import sys
import numpy as np

# print (str(sys.argv[1]))
json_file = str(sys.argv[1])
precipitation_file = str(sys.argv[2])
data = None
address_points = []
lat = -90
long = -180

with open(json_file, "r") as read_file:
    data = np.array(json.load(read_file)[3]['data'])

# data = 3*(data - np.min(data))/np.ptp(data)

i = 0
while (lat < 91):
    long = -180
    while (long < 180):
        address_points.append([lat, long, data[i]])
        # address_points.append(data[i])
        i += 1
        long += 1
    lat += 1

# print(address_points)
# print(len(address_points))
# print(i)
# print(len(data))

with open(precipitation_file, "w") as write_file:
    write_file.write("{\"data\": " + str(address_points) + "}")