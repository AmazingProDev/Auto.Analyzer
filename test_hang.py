import server, json, time

def trace_calls():
    import sys
    def trace(frame, event, arg):
        if event == 'call':
            name = frame.f_code.co_name
            if name.startswith('_'):
                print(f"Calling: {name}")
        return trace
    sys.settrace(trace)

with open(server.BENCHMARK_NEMO_CONFIG_PATH, 'r') as f:
    paths = json.load(f).get('paths', [])
print('Testing paths:', paths)
import threading
def watchdog():
    time.sleep(10)
    print("Watchdog timeout!")
    import os, signal
    os.kill(os.getpid(), signal.SIGQUIT)
threading.Thread(target=watchdog, daemon=True).start()

trace_calls()
res = server._load_benchmark_nemo_files(paths)
print('Done!')
