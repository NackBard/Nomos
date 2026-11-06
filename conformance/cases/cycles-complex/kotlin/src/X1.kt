package cx.left

class X1 {
    lateinit var next: X2
}

class X2 {
    lateinit var back: X1
    lateinit var bridge: cx.right.Y1
}
