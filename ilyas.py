def ilyas_sort(arr):
    new_arr = []
    
    while arr:
        new_arr.append(min(arr))
        arr.remove(min(arr))
    
    return new_arr

print(ilyas_sort([5,6,2,1,0]))