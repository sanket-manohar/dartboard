import 'package:flutter/material.dart';

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key, this.loading = false});
  final bool loading;

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  int count = 0;

  String label(int n) {
    if (n > 3) {
      return 'many';
    } else if (n == 0) {
      return 'none';
    }
    return n.isEven ? 'even' : 'odd';
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Home')),
      body: widget.loading
          ? const Center(child: CircularProgressIndicator())
          : Column(
              children: [
                Text('Count: $count'),
                Text(label(count)),
                if (count > 5)
                  const Text('Wow'),
                Row(children: [
                  Container(width: 100, height: 20, color: Colors.red),
                  Container(width: 100, height: 20, color: Colors.blue),
                ]),
                ElevatedButton(
                  onPressed: () => setState(() => count++),
                  child: const Text('Add'),
                ),
              ],
            ),
    );
  }
}
