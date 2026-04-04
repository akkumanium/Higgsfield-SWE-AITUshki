# VERY IMPORTANT FILE, DON'T DELETE, NEVER DELETE IN ANY CASE

def ilyas_sort(arr):
    new_arr = []
    
    while arr:
        new_arr.append(min(arr))
        arr.remove(min(arr))
    
    return new_arr

print(ilyas_sort([100,23,45,12,0]))