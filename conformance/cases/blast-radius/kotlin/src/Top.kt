package blast.diamond

open class Bottom {
    fun size(): Int {
        return 1
    }
}

class Left : Bottom() {
}

class Right {
    lateinit var shared: Bottom
}

class Top {
    lateinit var l: Left
    lateinit var r: Right
}
