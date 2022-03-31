module.exports = function(grunt) {
    grunt.initConfig({
        pkg: grunt.file.readJSON('package.json'),
        ts: {
            attic : {
                outDir: "./lib",
                tsconfig: './tsconfig.json'
            },
            options: {
                "rootDir": "./src"
            }
        },
        clean: ['lib', '.tscache']
    });

    grunt.loadNpmTasks('grunt-ts');
    grunt.loadNpmTasks('grunt-contrib-clean');
    grunt.registerTask('default', [  'clean', 'ts:attic' ]);
};