import React from 'react';
import './BlogPage.css';

const posts = [
  { id: 1, title: 'The Benefits of Bone Broth', excerpt: 'Learn about the amazing health benefits of bone broth.' },
  { id: 2, title: 'Our Favorite Broth Recipes', excerpt: 'Discover new and delicious ways to use our broths.' },
];

const BlogPage = () => {
  return (
    <div className="blog-page">
      <h1>From the Blog</h1>
      <div className="blog-posts">
        {posts.map(post => (
          <div key={post.id} className="post-card">
            <h2>{post.title}</h2>
            <p>{post.excerpt}</p>
            <a href="#">Read More</a>
          </div>
        ))}
      </div>
    </div>
  );
};

export default BlogPage;