import server, time
t0 = time.time()
path = '/Users/abdelilah/Documents/My projects/Sites and Data/Sites/BDD_Mensuel_M04.xlsx'
print("Parsing", path)
server._write_bdd_sectors_json(path)
print("Finished in", time.time() - t0, "seconds.")
